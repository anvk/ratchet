import { startWorkers, stopWorkers, store, waitForFinish } from "./harness.ts";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { defineWorkflow } from "../src/index.ts";
import { db } from "../src/stores/postgres/index.ts";
import { diamond } from "./fixtures/workflows.ts";

before(() => startWorkers(6));
after(() => stopWorkers());

/** Each step of a run by name: its status, output, attempt and when it ran. */
async function stepsOf(runId: string) {
  const rows = await db
    .selectFrom("step_runs")
    .select(["name", "status", "output", "attempt", "started_at", "finished_at"])
    .where("run_id", "=", runId)
    .execute();
  return Object.fromEntries(rows.map((row) => [row.name, row]));
}

/** How many times a run's step was claimed. */
async function claimsOf(runId: string, stepName: string) {
  const rows = await db
    .selectFrom("events")
    .select("id")
    .where("run_id", "=", runId)
    .where("type", "=", "step_claimed")
    .where("step_name", "=", stepName)
    .execute();
  return rows.length;
}

test("branches run side by side, and the join runs once when both are done", async () => {
  // Three runs at a time, so each run's two branches get a free worker each,
  // start together and finish together, racing to ready the join. Without the
  // run lock, some joins never start.
  const runIds: string[] = [];
  for (let batch = 0; batch < 40; batch++) {
    const ids = await Promise.all(
      Array.from({ length: 3 }, () => store.startRun({ definition: diamond })),
    );
    await waitForFinish(ids, 10_000);
    runIds.push(...ids);
  }

  let overlapping = 0;
  for (const runId of runIds) {
    const steps = await stepsOf(runId);
    assert.equal(steps.join.status, "succeeded");
    assert.equal(await claimsOf(runId, "join"), 1, "the join is readied exactly once");
    const { left, right } = steps;
    if (left.started_at! < right.finished_at! && right.started_at! < left.finished_at!) {
      overlapping++;
    }
  }
  assert.ok(overlapping > runIds.length / 2, `only ${overlapping} runs had overlapping branches`);

  const run = await db
    .selectFrom("workflow_runs")
    .select("status")
    .where("id", "in", runIds)
    .where("status", "!=", "succeeded")
    .execute();
  assert.equal(run.length, 0);
});

test("a step sees the outputs of everything it depends on, but not of a parallel branch", async () => {
  const runId = await store.startRun({ definition: diamond });
  await waitForFinish([runId]);

  const steps = await stepsOf(runId);
  assert.deepEqual(steps.left.output, { seen: ["start"] });
  assert.deepEqual(steps.right.output, { seen: ["start"] });
  assert.deepEqual(steps.join.output, { seen: ["left", "right", "start"] });
  assert.deepEqual(steps.tail.output, { seen: ["right", "start"] });
});

test("a failed branch only stops what depends on it: the rest of the run carries on", async () => {
  // left fails after 300ms; right takes a second, then tail (which only needs right) runs.
  const runId = await store.startRun({
    definition: diamond,
    input: { failBranch: "left", branchMs: 300, survivorMs: 1_000 },
  });
  await waitForFinish([runId]);

  const steps = await stepsOf(runId);
  assert.equal(steps.left.status, "failed");
  assert.equal(steps.right.status, "succeeded", "a branch that doesn't need left finishes");
  assert.equal(steps.tail.status, "succeeded", "and steps after it still start");
  assert.ok(steps.tail.started_at! > steps.left.finished_at!, "tail started after left failed");
  assert.equal(steps.join.status, "skipped", "join needs left, so it can never run");

  const run = await db
    .selectFrom("workflow_runs")
    .select(["status", "failure_reason", "finished_at"])
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  assert.equal(run.status, "failed");
  assert.equal(run.failure_reason, "non_retryable");
  assert.ok(run.finished_at! >= steps.tail.finished_at!, "the run ends when nothing can move");
});

test("defineWorkflow only lets a step need steps listed before it", () => {
  /** A workflow whose second step needs the given steps. */
  const needing = (needs: string[]) =>
    defineWorkflow({
      name: "bad",
      steps: [
        { name: "a", run: async () => null },
        { name: "b", needs, run: async () => null },
        { name: "c", run: async () => null },
      ],
    });

  assert.throws(() => needing(["missing"]), /bad\/b needs missing, which isn't a step listed/);
  assert.throws(() => needing(["b"]), /bad\/b needs b/, "a step can't need itself");
  assert.throws(() => needing(["c"]), /bad\/b needs c/, "or a step after it, which could loop");
  assert.throws(() => needing(["a", "a"]), /Duplicate need in Step bad\/b: a/);
  assert.doesNotThrow(() => needing([]));
  assert.doesNotThrow(() => needing(["a"]));
});
