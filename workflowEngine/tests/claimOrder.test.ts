import { startWorkers, stopWorkers, store, waitForFinish } from "./harness.ts";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createWorkflowEngine, type ClaimOrder } from "../src/index.ts";
import { db } from "../src/stores/postgres/index.ts";
import { pipeline, workflows } from "./fixtures/workflows.ts";

// No worker processes: each test runs its own workers in this process, with
// the claim order it is checking.
before(() => startWorkers(0));
after(() => stopWorkers());

/**
 * Starts the runs one after another, works through them with in-process
 * workers using this claim order, and returns every claim in the order it
 * happened, as `run:step` with the worker that took it.
 */
async function claimsWith({
  order,
  runs,
  workerCount,
}: {
  order: ClaimOrder;
  runs: number;
  workerCount: number;
}) {
  const runIds: string[] = [];
  for (let i = 0; i < runs; i++) runIds.push(await store.startRun({ definition: pipeline }));

  // The shared store stays open for the next test, so closing the engine mustn't close it.
  const engine = createWorkflowEngine({
    workflows,
    store: { ...store, close: async () => {} },
    settings: { pollMs: 5, claimOrder: order },
  });
  for (let i = 1; i <= workerCount; i++) void engine.runWorker({ workerId: `worker-${i}` });
  await waitForFinish(runIds);
  await engine.close();

  const claims = await db
    .selectFrom("events")
    .select(["run_id", "step_name", "worker_id"])
    .where("run_id", "in", runIds)
    .where("type", "=", "step_claimed")
    .orderBy("id")
    .execute();
  const label = (runId: string) => "ABCDEFGHIJ"[runIds.indexOf(runId)];
  return claims.map((c) => ({ step: `${label(c.run_id)}:${c.step_name}`, worker: c.worker_id }));
}

test("fair: runs take turns, so they move forward together", async () => {
  const claims = await claimsWith({ order: "fair", runs: 2, workerCount: 1 });
  assert.deepEqual(
    claims.map((c) => c.step),
    ["A:first", "B:first", "A:second", "B:second", "A:third", "B:third"],
  );
});

test("oldest-run-first: the oldest run finishes before the next one starts", async () => {
  const claims = await claimsWith({ order: "oldest-run-first", runs: 2, workerCount: 1 });
  assert.deepEqual(
    claims.map((c) => c.step),
    ["A:first", "A:second", "A:third", "B:first", "B:second", "B:third"],
  );
});

test("sticky: a worker finishes its run before taking another", async () => {
  const claims = await claimsWith({ order: "sticky", runs: 2, workerCount: 1 });
  assert.deepEqual(
    claims.map((c) => c.step),
    ["A:first", "A:second", "A:third", "B:first", "B:second", "B:third"],
  );
});

test("sticky: each run stays on the worker that started it", async () => {
  // Three workers, because with two and identical steps, fair order happens to
  // alternate perfectly and keep each run on one worker too.
  const claims = await claimsWith({ order: "sticky", runs: 10, workerCount: 3 });

  const workersByRun = new Map<string, Set<string | null>>();
  for (const { step, worker } of claims) {
    const run = step.split(":")[0];
    workersByRun.set(run, (workersByRun.get(run) ?? new Set()).add(worker));
  }
  assert.equal(workersByRun.size, 10);
  for (const [run, workers] of workersByRun) {
    assert.equal(workers.size, 1, `run ${run} moved between workers: ${[...workers].join(", ")}`);
  }

  // Otherwise this test could pass with one worker doing everything.
  assert.ok(new Set(claims.map((c) => c.worker)).size > 1, "expected several workers to take runs");
});
