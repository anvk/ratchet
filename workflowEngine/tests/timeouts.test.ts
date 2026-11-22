import { startWorkers, stopWorkers, store, waitForFinish } from "./harness.ts";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createWorkflowEngine,
  createPollingMessageBroker,
  defineWorkflow,
  type StepFunction,
} from "../src/index.ts";
import { db } from "../src/stores/postgres/index.ts";
import { fakeStore } from "./fakeStore.ts";
import { stalling } from "./fixtures/workflows.ts";

// Real workers run the stalling workflow. The tests with a fake store run their
// steps in this process and never touch the database.
before(() => startWorkers(2));
after(() => stopWorkers());

/**
 * Runs a one-step workflow once on a worker over a fake store, and returns what
 * the store saw. `engineTimeoutMs` is the engine's setting, for steps without their own.
 */
async function runOnce(step: { timeoutMs?: number; run: StepFunction }, engineTimeoutMs = 60_000) {
  const wf = defineWorkflow({
    name: "timed",
    version: "1",
    run: (ctx) =>
      ctx.step(
        "timed",
        step.run,
        step.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs },
      ),
  });
  const { store: fake, calls } = fakeStore({ workflow: "timed" });
  const engine = createWorkflowEngine({
    messageBroker: createPollingMessageBroker({ everyMs: 5 }),
    workflows: [wf],
    store: fake,
    settings: { timeoutMs: engineTimeoutMs },
  });
  const worker = engine.runWorker();
  return { engine, worker, calls };
}

/** Waits until a condition holds, and throws after the deadline. */
async function until(condition: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition not met in time");
    await sleep(5);
  }
}

/** Resolves once the signal aborts. */
const aborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));

test("a step that runs past its timeout fails that attempt", async () => {
  const { engine, worker, calls } = await runOnce({
    timeoutMs: 50,
    run: (ctx) => aborted(ctx.abortSignal),
  });
  await until(() => calls.failures.length > 0);
  await engine.close();
  await worker;
  assert.deepEqual(calls.failures, [{ error: "Timed out after 50ms", final: null }]);
  assert.equal(calls.completed, 0);
});

test("the timeout fires ctx.abortSignal", async () => {
  let signalAborted = false;
  const { engine, worker, calls } = await runOnce({
    timeoutMs: 50,
    async run(ctx) {
      await aborted(ctx.abortSignal);
      signalAborted = true;
    },
  });
  await until(() => calls.failures.length > 0 && signalAborted);
  await engine.close();
  await worker;
  assert.equal(signalAborted, true);
});

test("a step that finishes in time is not affected", async () => {
  const { engine, worker, calls } = await runOnce({ timeoutMs: 1000, run: async () => "done" });
  await until(() => calls.completed > 0);
  const started = Date.now();
  await engine.close();
  await worker;
  assert.ok(Date.now() - started < 500, "a finished step must not leave its timer pending");
  assert.deepEqual(calls.outputs, ["done"]);
  assert.equal(calls.failures.length, 0);
});

test("what a timed-out step returns later is ignored", async () => {
  const { engine, worker, calls } = await runOnce({
    timeoutMs: 50,
    async run() {
      await sleep(150);
      return "late";
    },
  });
  await sleep(400);
  await engine.close();
  await worker;
  assert.equal(calls.completed, 0);
  assert.equal(calls.failures.length, 1);
});

test("what a timed-out step throws later doesn't crash the worker", async () => {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    const { engine, worker, calls } = await runOnce({
      timeoutMs: 50,
      async run() {
        await sleep(150);
        throw new Error("late failure");
      },
    });
    await sleep(400);
    await engine.close();
    await worker;
    assert.equal(calls.failures.length, 1);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", listener);
  }
});

test("a step without its own timeout gets the engine's", async () => {
  const { engine, worker, calls } = await runOnce({ run: (ctx) => aborted(ctx.abortSignal) }, 50);
  await until(() => calls.failures.length > 0);
  await engine.close();
  await worker;
  assert.deepEqual(calls.failures, [{ error: "Timed out after 50ms", final: null }]);
});

test("a step's own timeout wins over the engine's", async () => {
  const { engine, worker, calls } = await runOnce(
    {
      timeoutMs: 1000,
      async run() {
        await sleep(200);
        return "slow";
      },
    },
    50,
  );
  await until(() => calls.completed > 0);
  await engine.close();
  await worker;
  assert.equal(calls.failures.length, 0);
});

test("an engine can't be created without a whole, positive timeoutMs", () => {
  const { store: fake } = fakeStore({ workflow: "timed" });
  const create = (settings: object) =>
    createWorkflowEngine({
      messageBroker: createPollingMessageBroker(),
      workflows: [],
      store: fake,
      settings: settings as never,
    });
  for (const settings of [{}, { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: 1.5 }]) {
    assert.throws(() => create(settings), /needs a whole, positive timeoutMs setting/);
  }
  assert.doesNotThrow(() => create({ timeoutMs: 1 }));
});

/** A run's one step and its retry events. */
async function stalledRun(hangAttempts: number) {
  const runId = await store.startRun({ definition: stalling, input: { hangAttempts } });
  await waitForFinish([runId]);
  const run = await db
    .selectFrom("workflow_runs")
    .select(["status", "failure_reason"])
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  const step = await db
    .selectFrom("step_runs")
    .select(["attempt", "error", "output"])
    .where("run_id", "=", runId)
    .executeTakeFirstOrThrow();
  const retries = await db
    .selectFrom("events")
    .select(["detail"])
    .where("run_id", "=", runId)
    .where("type", "=", "step_retry_scheduled")
    .execute();
  return { run, step, retries };
}

test("a timed-out attempt is retried, and the run carries on", async () => {
  const { run, step, retries } = await stalledRun(1);
  assert.equal(run.status, "succeeded");
  assert.equal(step.attempt, 2);
  assert.equal(retries.length, 1);
  assert.equal((retries[0].detail as { error: string }).error, "Timed out after 300ms");
});

test("a step that always times out runs out of attempts", async () => {
  const { run, step } = await stalledRun(99);
  assert.equal(run.status, "failed");
  assert.equal(run.failure_reason, "attempts_exhausted");
  assert.equal(step.error, "Timed out after 300ms");
  assert.equal(step.attempt, 3);
});

test("a step asked for with a timeoutMs that isn't a whole, positive number fails its run", async () => {
  const bad = defineWorkflow<{ timeoutMs: number }>({
    name: "timeout-bad",
    version: "1",
    run: (ctx) => ctx.step("only", () => null, { timeoutMs: ctx.input.timeoutMs }),
  });
  const engine = createWorkflowEngine({
    messageBroker: createPollingMessageBroker({ everyMs: 5 }),
    workflows: [bad],
    store: { ...store, close: async () => {} },
    settings: { timeoutMs: 60_000 },
  });
  await engine.sync();
  const worker = engine.runWorker({ workerId: "timeout-bad" });
  try {
    for (const timeoutMs of [0, -1, 1.5]) {
      const runId = await engine.startRun({ workflow: "timeout-bad", input: { timeoutMs } });
      await waitForFinish([runId]);
      const run = await db
        .selectFrom("workflow_runs")
        .select(["status", "failure_reason"])
        .where("id", "=", runId)
        .executeTakeFirstOrThrow();
      assert.deepEqual(run, { status: "failed", failure_reason: "workflow_error" });
    }
    const runId = await engine.startRun({ workflow: "timeout-bad", input: { timeoutMs: 5000 } });
    await waitForFinish([runId]);
    const run = await db
      .selectFrom("workflow_runs")
      .select("status")
      .where("id", "=", runId)
      .executeTakeFirstOrThrow();
    assert.equal(run.status, "succeeded");
  } finally {
    await engine.close();
    await worker;
  }
});

test("changing what a step is asked for with does not create a new version; changing `version` does", async () => {
  const define = ({ timeoutMs, version }: { timeoutMs: number; version: string }) =>
    defineWorkflow({
      name: "timeout-versioned",
      version,
      run: (ctx) => ctx.step("only", () => null, { timeoutMs }),
    });
  const sync = (workflow: ReturnType<typeof define>) =>
    createWorkflowEngine({
      messageBroker: createPollingMessageBroker(),
      workflows: [workflow],
      store,
      settings: { timeoutMs: 60_000 },
    }).sync();
  const versions = () =>
    db.selectFrom("workflows").select("id").where("name", "=", "timeout-versioned").execute();

  await sync(define({ timeoutMs: 1000, version: "1" }));
  await sync(define({ timeoutMs: 2000, version: "1" }));
  assert.equal((await versions()).length, 1);

  await sync(define({ timeoutMs: 2000, version: "2" }));
  assert.equal((await versions()).length, 2);
});
