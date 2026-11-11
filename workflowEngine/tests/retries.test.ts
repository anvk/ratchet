import { startWorkers, stopWorkers, store, waitForFinish } from "./harness.ts";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createWorkflowEngine } from "../src/index.ts";
import { db } from "../src/stores/postgres/index.ts";
import { doomed, flaky, workflows } from "./fixtures/workflows.ts";

// Real worker processes run the steps. An orchestrator runs here for the test
// about lost leases, sharing the store, which must stay open.
const orchestrator = createWorkflowEngine({
  workflows,
  store: { ...store, close: async () => {} },
  settings: { sweepIntervalMs: 50 },
});

before(async () => {
  await startWorkers(3);
  void orchestrator.runOrchestrator();
});
after(async () => {
  await orchestrator.close();
  await stopWorkers();
});

/** A run's status and failure reason, and one of its steps. */
async function outcome(runId: string, stepName: string) {
  const run = await db
    .selectFrom("workflow_runs")
    .select(["status", "failure_reason"])
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  const step = await db
    .selectFrom("step_runs")
    .select(["status", "attempt", "error", "output", "failure_reason"])
    .where("run_id", "=", runId)
    .where("name", "=", stepName)
    .executeTakeFirstOrThrow();
  return { run: run.status, runReason: run.failure_reason, step };
}

/** A run's events of one type, oldest first, with when they happened. */
const eventsOf = (runId: string, type: string) =>
  db
    .selectFrom("events")
    .select(["attempt", "detail", "at"])
    .where("run_id", "=", runId)
    .where("type", "=", type)
    .orderBy("id")
    .execute();

test("a failing step is retried until it succeeds, and the run carries on", async () => {
  const runId = await store.startRun({ definition: flaky, input: { failures: 2 } });
  await waitForFinish([runId]);

  const { run, step } = await outcome(runId, "call");
  assert.equal(run, "succeeded");
  assert.equal(step.attempt, 3);
  assert.deepEqual(step.output, { attempt: 3 });
  assert.equal(step.error, null, "success clears the last attempt's error");
  assert.equal(step.failure_reason, null);
  const retries = await eventsOf(runId, "step_retry_scheduled");
  assert.deepEqual(
    retries.map((r) => r.attempt),
    [1, 2],
  );
});

test("each retry waits for its backoff, which doubles", async () => {
  const runId = await store.startRun({ definition: flaky, input: { failures: 2 } });
  await waitForFinish([runId]);

  const retries = await eventsOf(runId, "step_retry_scheduled");
  const claims = await db
    .selectFrom("events")
    .select(["attempt", "at"])
    .where("run_id", "=", runId)
    .where("type", "=", "step_claimed")
    .where("step_name", "=", "call")
    .orderBy("id")
    .execute();

  // backoffMs 50, so about 50ms then 100ms, give or take 20%.
  const waits = retries.map((r) => (r.detail as { retryInMs: number }).retryInMs);
  assert.ok(waits[0] >= 40 && waits[0] <= 60, `first wait ${waits[0]}ms`);
  assert.ok(waits[1] >= 80 && waits[1] <= 120, `second wait ${waits[1]}ms`);
  for (const [i, retry] of retries.entries()) {
    const nextClaim = claims[i + 1];
    const waited = nextClaim.at.getTime() - retry.at.getTime();
    assert.ok(
      waited >= waits[i] - 5,
      `attempt ${i + 2} started after ${waited}ms, before its backoff`,
    );
  }
});

test("a step that keeps failing fails its run after maxAttempts", async () => {
  const runId = await store.startRun({ definition: flaky, input: { failures: 10 } });
  await waitForFinish([runId]);

  const { run, runReason, step } = await outcome(runId, "call");
  assert.equal(run, "failed");
  assert.equal(step.status, "failed");
  assert.equal(step.failure_reason, "attempts_exhausted");
  assert.equal(runReason, "attempts_exhausted");
  assert.equal(step.attempt, 4, "maxAttempts is 4");
  assert.equal(step.error, "Timed out on attempt 4");
  assert.equal((await eventsOf(runId, "step_retry_scheduled")).length, 3);
  const after = await outcome(runId, "after");
  assert.equal(after.step.status, "skipped");
});

test("a NonRetryableError fails the run at once", async () => {
  const runId = await store.startRun({ definition: flaky, input: { final: true } });
  await waitForFinish([runId]);

  const { run, runReason, step } = await outcome(runId, "call");
  assert.equal(run, "failed");
  assert.equal(step.failure_reason, "non_retryable");
  assert.equal(runReason, "non_retryable");
  assert.equal(step.attempt, 1);
  assert.equal(step.error, "Declined");
  assert.equal((await eventsOf(runId, "step_retry_scheduled")).length, 0);
});

test("a step that keeps losing its lease fails its run after maxAttempts", async () => {
  const runId = await store.startRun({ definition: doomed });
  await waitForFinish([runId], 20_000);

  const { run, runReason, step } = await outcome(runId, "hog");
  assert.equal(run, "failed");
  assert.equal(step.failure_reason, "lost_worker");
  assert.equal(runReason, "lost_worker");
  assert.equal(step.attempt, 2, "maxAttempts is 2");
  assert.equal(step.error, "Lost its worker on attempt 2 of 2");
  assert.equal((await eventsOf(runId, "step_lease_expired")).length, 2);
});

/** How many times a run's step was claimed. */
const claimsOf = async (runId: string, stepName: string) =>
  (
    await db
      .selectFrom("events")
      .select("id")
      .where("run_id", "=", runId)
      .where("type", "=", "step_claimed")
      .where("step_name", "=", stepName)
      .execute()
  ).length;

test("redriving a run that ran out of attempts resumes it from the failed step", async () => {
  // Attempts 1 to 5 fail: 4 before the redrive, then 1 of its fresh 4.
  const runId = await store.startRun({ definition: flaky, input: { failures: 5 } });
  await waitForFinish([runId]);
  assert.equal((await outcome(runId, "call")).runReason, "attempts_exhausted");

  assert.equal(await store.redriveRun({ runId }), true);
  await waitForFinish([runId]);

  const { run, runReason, step } = await outcome(runId, "call");
  assert.equal(run, "succeeded");
  assert.equal(runReason, null);
  assert.equal(step.attempt, 6, "attempt numbers carry on, so old workers can't match");
  assert.deepEqual(step.output, { attempt: 6 });
  assert.equal(await claimsOf(runId, "prepare"), 1, "a step that succeeded doesn't run again");
  assert.equal((await outcome(runId, "after")).step.status, "succeeded");
  assert.equal((await eventsOf(runId, "run_redriven")).length, 1);
});

test("a run that failed on a decision, or didn't fail, can't be redriven", async () => {
  const declined = await store.startRun({ definition: flaky, input: { final: true } });
  const fine = await store.startRun({ definition: flaky, input: {} });
  await waitForFinish([declined, fine]);

  assert.equal(await store.redriveRun({ runId: declined }), false);
  assert.equal(await store.redriveRun({ runId: fine }), false);
  assert.equal((await outcome(declined, "call")).run, "failed");
  assert.equal((await eventsOf(declined, "run_redriven")).length, 0);
});
