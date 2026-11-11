import { signalWorker, startWorkers, stopWorkers, store, waitForFinish } from "./harness.ts";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "kysely";
import { createWorkflowEngine, defineWorkflow, type StepDefaults } from "../src/index.ts";
import { db } from "../src/stores/postgres/index.ts";
import { slow, workflows } from "./fixtures/workflows.ts";

// Real worker processes run the steps. The orchestrator runs here, sweeping
// often, and shares the store, which must stay open for the other tests.
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

/** Engine defaults for the tests that call the store directly, with a long lease. */
const defaults: StepDefaults = {
  leaseMs: 60_000,
  maxAttempts: 3,
  backoffMs: 1000,
  maxBackoffMs: 30_000,
};

/** The "work" step of a run of the slow workflow. */
const workStep = (runId: string) =>
  db
    .selectFrom("step_runs")
    .select(["status", "attempt", "worker_id", "output"])
    .where("run_id", "=", runId)
    .where("name", "=", "work")
    .executeTakeFirstOrThrow();

/** A run's events of one type. */
const eventsOf = (runId: string, type: string) =>
  db
    .selectFrom("events")
    .select(["step_name", "attempt", "worker_id"])
    .where("run_id", "=", runId)
    .where("type", "=", type)
    .execute();

/** Waits until check returns something truthy, and returns it. */
async function waitFor<T>(check: () => Promise<T>, timeoutMs = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(20);
  }
  throw new Error("Timed out waiting");
}

test("heartbeats keep a step that outlasts its lease alive", async () => {
  const runId = await store.startRun({ definition: slow, input: { waitMs: 1200 } });
  await waitForFinish([runId]);

  const work = await workStep(runId);
  assert.equal(work.attempt, 1, "the step should never have been taken away");
  assert.deepEqual(work.output, { attempt: 1, leaseLost: false });
  assert.equal((await eventsOf(runId, "step_lease_expired")).length, 0);
});

test("a step whose worker freezes goes to another worker, and the late result is rejected", async () => {
  const blockMs = 1500;
  const startedAt = Date.now();
  const runId = await store.startRun({ definition: slow, input: { blockMs } });
  await waitForFinish([runId]);

  const expired = await eventsOf(runId, "step_lease_expired");
  assert.equal(expired.length, 1);
  assert.equal(expired[0].attempt, 1);
  const frozenWorker = expired[0].worker_id;

  // Let the frozen worker wake up and try to finish its attempt.
  await sleep(Math.max(startedAt + blockMs + 500 - Date.now(), 0));

  const work = await workStep(runId);
  assert.equal(work.status, "succeeded");
  assert.equal(work.attempt, 2);
  assert.deepEqual(work.output, { attempt: 2, leaseLost: false }, "the late result must not win");
  assert.notEqual(work.worker_id, frozenWorker);
  const succeeded = (await eventsOf(runId, "step_succeeded")).filter((e) => e.step_name === "work");
  assert.equal(succeeded.length, 1, "only one attempt may succeed");
});

test("a step's own leaseMs wins over the default, and the sticky handoff gets a lease too", async () => {
  // Unknown to the worker processes, so this test can claim it itself.
  const leased = defineWorkflow({
    name: "leased",
    title: "Leased",
    description: "One step with its own lease, one without.",
    steps: [
      {
        name: "own",
        title: "Own",
        description: "Sets leaseMs.",
        leaseMs: 1234,
        run: async () => 1,
      },
      { name: "default", title: "Default", description: "Doesn't.", run: async () => 2 },
    ],
  });
  await store.syncWorkflows([leased]);
  const runId = await store.startRun({ definition: leased });

  /** How long the lease on a step was set for, measured in the database. */
  const leaseLength = (name: string) =>
    db
      .selectFrom("step_runs")
      .select(
        sql<number>`extract(epoch from lease_expires_at - started_at)::float8 * 1000`.as("ms"),
      )
      .where("run_id", "=", runId)
      .where("name", "=", name)
      .executeTakeFirstOrThrow()
      .then((row) => Math.round(row.ms));

  const claim = await store.claimStep({
    workerId: "test",
    workflows: [leased],
    order: "fair",
    defaults,
  });
  assert.equal(claim?.leaseMs, 1234);
  assert.equal(await leaseLength("own"), 1234);

  const { next } = await store.completeStep({
    claim: claim!,
    output: 1,
    claimNext: true,
    defaults,
  });
  assert.equal(next?.stepName, "default");
  assert.equal(next?.leaseMs, 60_000);
  assert.equal(await leaseLength("default"), 60_000);
});

test("a swept step can't be renewed or finished by the worker that lost it", async () => {
  const lost = defineWorkflow({
    name: "lost",
    title: "Lost",
    description: "Its lease is made to expire.",
    steps: [{ name: "only", title: "Only", description: "A step.", run: async () => null }],
  });
  await store.syncWorkflows([lost]);
  const runId = await store.startRun({ definition: lost });
  const claim = await store.claimStep({
    workerId: "test",
    workflows: [lost],
    order: "fair",
    defaults,
  });
  assert.ok(claim);
  assert.equal(await store.extendLease(claim), true);

  await db
    .updateTable("step_runs")
    .set({ lease_expires_at: sql<Date>`now() - interval '1 second'` })
    .where("id", "=", claim.stepRunId)
    .execute();
  // The orchestrator may sweep it first, which is just as good.
  await store.sweepExpiredLeases({ defaults });

  const step = await db
    .selectFrom("step_runs")
    .select(["status", "worker_id"])
    .where("id", "=", claim.stepRunId)
    .executeTakeFirstOrThrow();
  assert.deepEqual(step, { status: "ready", worker_id: null });
  assert.equal(await store.extendLease(claim), false);
  const { completed } = await store.completeStep({
    claim,
    output: "late",
    claimNext: false,
    defaults,
  });
  assert.equal(completed, false);
  assert.equal((await eventsOf(runId, "step_lease_expired")).length, 1);
});

test("defineWorkflow rejects a leaseMs that isn't a whole, positive number", () => {
  for (const leaseMs of [0, -5, 1.5]) {
    assert.throws(
      () =>
        defineWorkflow({
          name: "bad",
          title: "Bad",
          description: "Bad lease.",
          steps: [
            { name: "only", title: "Only", description: "A step.", leaseMs, run: async () => null },
          ],
        }),
      /needs a whole, positive leaseMs/,
    );
  }
});

// Last, because it leaves one worker fewer for the tests after it.
test("a step whose worker is killed goes to another worker", async () => {
  const runId = await store.startRun({ definition: slow, input: { waitMs: 30_000 } });
  const running = await waitFor(async () => {
    const work = await workStep(runId);
    return work.status === "running" ? work : undefined;
  });
  signalWorker(running.worker_id!, "SIGKILL");
  await waitForFinish([runId], 10_000);

  const work = await workStep(runId);
  assert.equal(work.status, "succeeded");
  assert.equal(work.attempt, 2);
  assert.notEqual(work.worker_id, running.worker_id);
  const expired = await eventsOf(runId, "step_lease_expired");
  assert.deepEqual(
    expired.map((e) => e.worker_id),
    [running.worker_id],
  );
});
