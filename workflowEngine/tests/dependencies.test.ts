import { startWorkers, stopWorkers, store, waitForFinish } from "./harness.ts";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db } from "../src/stores/postgres/index.ts";
import { diamond } from "./fixtures/workflows.ts";

before(() => startWorkers(6));
after(() => stopWorkers());

/** Each step of a run by name: its status, output, attempt and when it ran. */
async function stepsOf(runId: string) {
  const rows = await db
    .selectFrom("step_runs")
    .select([
      "name",
      "status",
      "output",
      "attempt",
      "started_at",
      "finished_at",
      "failure_reason",
      "asked_after",
    ])
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

test("steps asked for together run side by side, and the step after both runs once", async () => {
  // Three runs at a time, so each run's two branches get a free worker each,
  // start together and finish together, each advancing the run as it finishes.
  // Without the run lock, both could advance from a state that lacks the
  // other's result, and the join would never be asked for.
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
    assert.equal(await claimsOf(runId, "join"), 1, "the join is asked for exactly once");
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

test("every step of a run finishes with what its code returned", async () => {
  const runId = await store.startRun({ definition: diamond });
  await waitForFinish([runId]);

  const steps = await stepsOf(runId);
  assert.deepEqual(steps.left.output, { seen: ["start"] });
  assert.deepEqual(steps.right.output, { seen: ["start"] });
  assert.deepEqual(steps.join.output, { seen: ["left", "right", "start"] });
  assert.deepEqual(steps.tail.output, { seen: ["right", "start"] });
});

test("a step records the steps it was asked for after", async () => {
  const runId = await store.startRun({ definition: diamond });
  await waitForFinish([runId]);

  const steps = await stepsOf(runId);
  assert.deepEqual(steps.start.asked_after, []);
  assert.deepEqual(steps.left.asked_after, ["start"]);
  assert.deepEqual(steps.right.asked_after, ["start"]);
  // Not "left", even when left had finished too: the tail doesn't wait for it.
  // And not "start" as well: right already comes after it.
  assert.deepEqual(steps.tail.asked_after, ["right"]);
  // Not the tail, even if the tail had finished by then.
  assert.deepEqual(steps.join.asked_after, ["left", "right"]);
});

test("when a step fails and the workflow doesn't catch it, the run fails at once and a step still running is stopped", async () => {
  // left fails after 300ms, while right would take another two seconds.
  const runId = await store.startRun({
    definition: diamond,
    input: { failBranch: "left", branchMs: 300, survivorMs: 2_500 },
  });
  await waitForFinish([runId]);

  const steps = await stepsOf(runId);
  assert.equal(steps.left.status, "failed");
  assert.equal(steps.left.failure_reason, "non_retryable");
  assert.equal(steps.right.status, "failed", "the step still running is stopped");
  assert.equal(steps.right.failure_reason, "cancelled");
  assert.equal(steps.join, undefined, "what came after is never asked for");
  assert.equal(steps.tail, undefined);

  const run = await db
    .selectFrom("workflow_runs")
    .select(["status", "failure_reason", "started_at", "finished_at"])
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  assert.equal(run.status, "failed");
  assert.equal(run.failure_reason, "non_retryable", "for the reason of the step that failed");
  assert.ok(
    run.finished_at!.getTime() - run.started_at!.getTime() < 1_500,
    "the run doesn't wait for the step that was still running",
  );

  // The stopped step's worker hears, lets go of it, and its late result is refused.
  const events = await db
    .selectFrom("events")
    .select("type")
    .where("run_id", "=", runId)
    .where("step_name", "=", "right")
    .orderBy("id")
    .execute();
  assert.deepEqual(
    events.map((e) => e.type),
    ["step_ready", "step_claimed", "step_failed"],
  );
});

test("a workflow that catches a step's failure carries on with everything that doesn't depend on it", async () => {
  // left fails after 300ms; right takes a second, then the tail, which only waits for right, runs.
  const runId = await store.startRun({
    definition: diamond,
    input: { failBranch: "left", branchMs: 300, survivorMs: 1_000, catchFailure: true },
  });
  await waitForFinish([runId]);

  const steps = await stepsOf(runId);
  assert.equal(steps.left.status, "failed");
  assert.equal(steps.right.status, "succeeded", "a step beside the failed one finishes");
  assert.equal(steps.tail.status, "succeeded", "and what comes after it still runs");
  assert.ok(steps.tail.started_at! > steps.left.finished_at!, "tail started after left failed");
  assert.equal(steps.join, undefined, "the join waits for left, so it is never asked for");

  const run = await db
    .selectFrom("workflow_runs")
    .select(["status", "output"])
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  assert.deepEqual(run, {
    status: "succeeded",
    output: { joined: "rejected", tailed: "fulfilled" },
  });
});
