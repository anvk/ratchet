import {
  advanceAll,
  advanceFor,
  startWorkers,
  stopWorkers,
  store,
  waitForFinish,
} from "./harness.ts";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  createPollingMessageBroker,
  createWorkflowEngine,
  defineWorkflow,
  NonRetryableError,
  StepFailedError,
  type StepDefaults,
  type WorkflowDefinition,
} from "../src/index.ts";
import { db } from "../src/stores/postgres/index.ts";

// What a workflow written as code can do, on the real store. No worker
// processes: each test runs its own worker in this process, so it can use
// workflows nothing else knows, or advance and claim by hand.
before(() => startWorkers(0));
after(() => stopWorkers());

const defaults: StepDefaults = {
  leaseMs: 60_000,
  maxAttempts: 3,
  backoffMs: 1000,
  maxBackoffMs: 30_000,
};

/** Starts a run of a workflow on a worker in this process, waits for it to finish, and stops the worker. */
async function runToEnd<Input>(definition: WorkflowDefinition<Input>, input?: Input) {
  const engine = createWorkflowEngine({
    workflows: [definition],
    store: { ...store, close: async () => {} },
    messageBroker: createPollingMessageBroker({ everyMs: 5 }),
    settings: { timeoutMs: 60_000, backoffMs: 10 },
  });
  await engine.sync();
  const worker = engine.runWorker({ workerId: `runs-${definition.name}` });
  try {
    const runId = await engine.startRun({ workflow: definition.name, input });
    await waitForFinish([runId], 10_000);
    return runId;
  } finally {
    await engine.close();
    await worker;
  }
}

/** A run's status, failure reason and output. */
const runRow = (runId: string) =>
  db
    .selectFrom("workflow_runs")
    .select(["status", "failure_reason", "output", "advance_at"])
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();

/** A run's steps, in the order the workflow asked for them. */
const stepRows = (runId: string) =>
  db
    .selectFrom("step_runs")
    .select(["name", "status", "failure_reason", "attempt", "output"])
    .where("run_id", "=", runId)
    .orderBy("position")
    .execute();

/** The names of a run's steps, in the order the workflow asked for them. */
const stepNames = async (runId: string) => (await stepRows(runId)).map((step) => step.name);

/** A run's events of one type, oldest first. */
const eventsOf = (runId: string, type: string) =>
  db
    .selectFrom("events")
    .select(["step_name", "detail"])
    .where("run_id", "=", runId)
    .where("type", "=", type)
    .orderBy("id")
    .execute();

test("a workflow chooses its steps as it goes, from what earlier steps returned", async () => {
  // Asks each vendor in turn until one answers, then uses that one.
  const vendors = defineWorkflow<{ vendors: string[]; working: string }>({
    name: "fn-vendors",
    version: "1",
    async run(ctx) {
      for (const vendor of ctx.input.vendors) {
        const answered = await ctx.step(`ask-${vendor}`, () => vendor === ctx.input.working);
        if (answered) return ctx.step("use", () => ({ used: vendor }));
      }
      throw new NonRetryableError("No vendor answered");
    },
  });

  const found = await runToEnd(vendors, { vendors: ["a", "b", "c"], working: "b" });
  assert.deepEqual(await stepNames(found), ["ask-a", "ask-b", "use"]);
  const run = await runRow(found);
  assert.equal(run.status, "succeeded");
  assert.deepEqual(run.output, { used: "b" });

  const none = await runToEnd(vendors, { vendors: ["a", "b"], working: "z" });
  assert.deepEqual(await stepNames(none), ["ask-a", "ask-b"]);
  const failed = await runRow(none);
  assert.equal(failed.status, "failed");
  assert.equal(failed.failure_reason, "non_retryable");
  const [event] = await eventsOf(none, "run_failed");
  assert.deepEqual(event.detail, { error: "No vendor answered", failureReason: "non_retryable" });
});

test("a workflow can ask for as many steps as its input says", async () => {
  const fanOut = defineWorkflow<{ items: number }>({
    name: "fn-fan-out",
    version: "1",
    async run(ctx) {
      const doubled = await Promise.all(
        Array.from({ length: ctx.input.items }, (_, i) => ctx.step(`double-${i}`, () => i * 2)),
      );
      return ctx.step("sum", () => doubled.reduce((total, n) => total + n, 0));
    },
  });

  const runId = await runToEnd(fanOut, { items: 12 });

  const steps = await stepRows(runId);
  assert.equal(steps.length, 13);
  assert.ok(steps.every((step) => step.status === "succeeded" && step.attempt === 1));
  assert.deepEqual((await runRow(runId)).output, 132);
});

test("a workflow can catch a step's failure and undo what it did", async () => {
  const booking = defineWorkflow({
    name: "fn-booking",
    version: "1",
    async run(ctx) {
      const flight = await ctx.step("book-flight", () => "FL-1");
      try {
        await ctx.step(
          "book-hotel",
          () => {
            throw new Error("No rooms");
          },
          { maxAttempts: 2 },
        );
      } catch (err) {
        if (!(err instanceof StepFailedError)) throw err;
        await ctx.step("cancel-flight", () => `cancelled ${flight}`);
        return { booked: false, because: err.message, reason: err.reason };
      }
      return { booked: true };
    },
  });

  const runId = await runToEnd(booking);

  assert.deepEqual(
    (await stepRows(runId)).map(({ name, status, failure_reason, attempt }) => ({
      name,
      status,
      failure_reason,
      attempt,
    })),
    [
      { name: "book-flight", status: "succeeded", failure_reason: null, attempt: 1 },
      { name: "book-hotel", status: "failed", failure_reason: "attempts_exhausted", attempt: 2 },
      { name: "cancel-flight", status: "succeeded", failure_reason: null, attempt: 1 },
    ],
  );
  const run = await runRow(runId);
  assert.equal(run.status, "succeeded", "a failure the workflow handled doesn't fail the run");
  assert.deepEqual(run.output, {
    booked: false,
    because: "No rooms",
    reason: "attempts_exhausted",
  });
});

test("an error in the workflow's own code fails the run with workflow_error, and a redrive runs the code again", async () => {
  let broken = true;
  const buggy = defineWorkflow({
    name: "fn-buggy",
    version: "1",
    async run(ctx) {
      const value = await ctx.step("load", () => 20);
      if (broken) throw new TypeError("value.total is not a function");
      return ctx.step("double", () => value * 2);
    },
  });

  const runId = await runToEnd(buggy);
  const failed = await runRow(runId);
  assert.equal(failed.status, "failed");
  assert.equal(failed.failure_reason, "workflow_error");
  assert.deepEqual(await stepNames(runId), ["load"]);
  const loadsBefore = (await eventsOf(runId, "step_claimed")).length;

  // The code is fixed (same version: runs in progress can carry on with it).
  broken = false;
  assert.equal(await store.redriveRun({ runId }), true);
  const engine = createWorkflowEngine({
    workflows: [buggy],
    store: { ...store, close: async () => {} },
    messageBroker: createPollingMessageBroker({ everyMs: 5 }),
    settings: { timeoutMs: 60_000 },
  });
  const worker = engine.runWorker({ workerId: "fixed" });
  try {
    await waitForFinish([runId], 10_000);
  } finally {
    await engine.close();
    await worker;
  }

  const run = await runRow(runId);
  assert.equal(run.status, "succeeded");
  assert.deepEqual(run.output, 40);
  assert.deepEqual(await stepNames(runId), ["load", "double"]);
  assert.equal(
    (await eventsOf(runId, "step_claimed")).length,
    loadsBefore + 1,
    "the step that had succeeded doesn't run again",
  );
});

test("a workflow that stops asking for a step it asked for before fails the run as nondeterministic", async () => {
  let stepName = "first-name";
  const renamed = defineWorkflow({
    name: "fn-renamed",
    version: "1",
    run: (ctx) => ctx.step(stepName, () => "done"),
  });
  await store.syncWorkflows([renamed]);
  const runId = await store.startRun({ definition: renamed });
  await advanceAll([renamed]);
  assert.deepEqual(await stepNames(runId), ["first-name"]);

  // The code changes under the run, without a new version.
  stepName = "second-name";
  const claim = await store.claimStep({
    workerId: "by-hand",
    workflows: [renamed],
    order: "fair",
    defaults,
  });
  assert.ok(claim);
  await store.completeStep({
    claim,
    output: "done",
    claimNext: false,
    defaults,
    advance: advanceFor([renamed]),
  });

  const run = await runRow(runId);
  assert.equal(run.status, "failed");
  assert.equal(run.failure_reason, "nondeterministic");
  const [event] = await eventsOf(runId, "run_failed");
  assert.match(
    (event.detail as { error: string }).error,
    /didn't ask again for steps it asked for before: first-name/,
  );
  assert.deepEqual(
    await stepNames(runId),
    ["first-name"],
    "the step it now asks for is not started",
  );
});

test("a step the code no longer asks for fails with unknown_step when a worker goes to run it", async () => {
  let stepName = "old";
  const moved = defineWorkflow({
    name: "fn-moved",
    version: "1",
    run: (ctx) => ctx.step(stepName, () => "done"),
  });
  await store.syncWorkflows([moved]);
  const runId = await store.startRun({ definition: moved });
  await advanceAll([moved]);

  // The step "old" is ready, and then a worker with different code picks it up.
  stepName = "new";
  const engine = createWorkflowEngine({
    workflows: [moved],
    store: { ...store, close: async () => {} },
    messageBroker: createPollingMessageBroker({ everyMs: 5 }),
    settings: { timeoutMs: 60_000 },
  });
  const worker = engine.runWorker({ workerId: "new-code" });
  try {
    await waitForFinish([runId], 10_000);
  } finally {
    await engine.close();
    await worker;
  }

  const [old] = await stepRows(runId);
  assert.equal(old.status, "failed");
  assert.equal(old.failure_reason, "unknown_step");
  assert.equal((await runRow(runId)).status, "failed");
});

test("if a run's code throws inside the engine's call, nothing changes and the run stays marked", async () => {
  const fragile = defineWorkflow({
    name: "fn-fragile",
    version: "1",
    run: (ctx) => ctx.step("only", () => "done"),
  });
  await store.syncWorkflows([fragile]);
  const runId = await store.startRun({ definition: fragile });

  // Stands for a worker that dies, or loses its connection, part-way through.
  await assert.rejects(
    store.advanceRun({
      workflows: [fragile],
      advance: async () => {
        throw new Error("worker died");
      },
    }),
    /worker died/,
  );

  const run = await runRow(runId);
  assert.equal(run.status, "queued");
  assert.notEqual(run.advance_at, null);
  assert.deepEqual(await stepRows(runId), []);

  // The next worker to look advances it.
  await advanceAll([fragile]);
  assert.equal((await runRow(runId)).advance_at, null);
  assert.deepEqual(await stepNames(runId), ["only"]);
  await db.deleteFrom("workflow_runs").where("id", "=", runId).execute();
});

test("a marked run that another transaction holds is waited for, not missed", async () => {
  const held = defineWorkflow({
    name: "fn-held",
    version: "1",
    run: (ctx) => ctx.step("only", () => "done"),
  });
  await store.syncWorkflows([held]);
  const runId = await store.startRun({ definition: held });

  // Something that isn't an advance holds the run for a moment, as a lease
  // sweep or a retry being scheduled would.
  let release = () => {};
  let locked = () => {};
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const holding = db.transaction().execute(async (trx) => {
    await trx
      .selectFrom("workflow_runs")
      .select("id")
      .where("id", "=", runId)
      .forNoKeyUpdate()
      .execute();
    locked();
    await new Promise<void>((resolve) => (release = resolve));
  });
  await isLocked;

  const advancing = store.advanceRun({ workflows: [held], advance: advanceFor([held]) });
  let settled = false;
  void advancing.then(() => (settled = true));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(settled, false, "it should be waiting for the run, not giving up on it");

  release();
  await holding;
  assert.equal(await advancing, true);
  assert.deepEqual(await stepNames(runId), ["only"]);
  await db.deleteFrom("workflow_runs").where("id", "=", runId).execute();
});

test("when a workflow returns, a step it started without waiting for is stopped", async () => {
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  const impatient = defineWorkflow({
    name: "fn-impatient",
    version: "1",
    async run(ctx) {
      // Asked for together, but only the quick one is waited for.
      const slow = ctx.step("slow", () => released.then(() => "slow"));
      const quick = await ctx.step("quick", () => "quick");
      void slow;
      return quick;
    },
  });
  const engine = createWorkflowEngine({
    workflows: [impatient],
    store: { ...store, close: async () => {} },
    messageBroker: createPollingMessageBroker({ everyMs: 5 }),
    settings: { timeoutMs: 60_000 },
  });
  await engine.sync();
  const workers = [
    engine.runWorker({ workerId: "impatient-1" }),
    engine.runWorker({ workerId: "impatient-2" }),
  ];
  try {
    const runId = await engine.startRun({ workflow: "fn-impatient" });
    await waitForFinish([runId], 10_000);

    const run = await runRow(runId);
    assert.equal(run.status, "succeeded");
    assert.deepEqual(run.output, "quick");
    const steps = Object.fromEntries((await stepRows(runId)).map((step) => [step.name, step]));
    assert.equal(steps.quick.status, "succeeded");
    assert.equal(steps.slow.status, "failed");
    assert.equal(steps.slow.failure_reason, "cancelled");

    // Its late result is refused.
    release();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const after = Object.fromEntries((await stepRows(runId)).map((step) => [step.name, step]));
    assert.equal(after.slow.status, "failed");
    assert.equal(after.slow.output, null);
  } finally {
    release();
    await engine.close();
    await Promise.all(workers);
  }
});

test("a step's settings come from where the workflow asks for it", async () => {
  const settings = defineWorkflow({
    name: "fn-settings",
    version: "1",
    run: (ctx) =>
      Promise.all([
        ctx.step("plain", () => null),
        ctx.step("tuned", () => null, { leaseMs: 1234, maxAttempts: 7, backoffMs: 5 }),
      ]),
  });
  await store.syncWorkflows([settings]);
  const runId = await store.startRun({ definition: settings });
  await advanceAll([settings]);

  const rows = await db
    .selectFrom("step_runs")
    .select(["name", "lease_ms", "max_attempts", "backoff_ms"])
    .where("run_id", "=", runId)
    .orderBy("position")
    .execute();
  assert.deepEqual(rows, [
    { name: "plain", lease_ms: null, max_attempts: null, backoff_ms: null },
    { name: "tuned", lease_ms: 1234, max_attempts: 7, backoff_ms: 5 },
  ]);
  await db.deleteFrom("workflow_runs").where("id", "=", runId).execute();
});
