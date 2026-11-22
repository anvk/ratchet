import { startWorkers, stopWorkers, store, waitForFinish } from "./harness.ts";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "kysely";
import {
  createPollingMessageBroker,
  createWorkflowEngine,
  defineWorkflow,
  type EngineMessage,
  type MessageBroker,
} from "../src/index.ts";
import { createPostgresMessageBroker } from "../src/messageBrokers/postgres/index.ts";
import { db } from "../src/stores/postgres/index.ts";
import { fakeStore } from "./fakeStore.ts";

// No worker processes: the workers here run in this process, so a test can give
// each its own broker.
before(() => startWorkers(0));
after(() => stopWorkers());

/** Waits until a condition holds, and throws after the deadline. */
async function until(condition: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition not met in time");
    await sleep(10);
  }
}

/** A broker inside this process: publish hands the message straight to the subscribers. */
function localBroker(): MessageBroker {
  const listeners: ((message: EngineMessage) => void)[] = [];
  return {
    publish: async (message) => listeners.forEach((listener) => listener(message)),
    subscribe: async (listener) => void listeners.push(listener),
    close: async () => {},
  };
}

/** The shared store, which must stay open for the other tests. */
const sharedStore = { ...store, close: async () => {} };

test("what one Postgres broker publishes, another's subscriber receives", async () => {
  const sender = createPostgresMessageBroker();
  const receiver = createPostgresMessageBroker();
  const received: EngineMessage[] = [];
  try {
    await receiver.subscribe((message) => received.push(message));

    await sender.publish({ type: "step_ready" });
    await sender.publish({ type: "run_cancelled", runId: "run-1" });

    await until(() => received.length === 2);
    assert.deepEqual(received, [{ type: "step_ready" }, { type: "run_cancelled", runId: "run-1" }]);
  } finally {
    await sender.close();
    await receiver.close();
  }
});

test("a Postgres broker tells its subscribers to look for work now and then, whatever it has heard", async () => {
  const broker = createPostgresMessageBroker({ everyMs: 50 });
  const received: EngineMessage[] = [];
  try {
    await broker.subscribe((message) => received.push(message));

    await until(() => received.length >= 2);

    assert.deepEqual(received.slice(0, 2), [{ type: "step_ready" }, { type: "step_ready" }]);
  } finally {
    await broker.close();
  }
});

test("a Postgres broker listens again after its connection is lost", async () => {
  const sender = createPostgresMessageBroker();
  const receiver = createPostgresMessageBroker();
  const received: EngineMessage[] = [];
  try {
    await receiver.subscribe((message) => received.push(message));
    const { rows } = await sql<{ killed: boolean }>`
      SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity
      WHERE datname = current_database() AND query = 'LISTEN ratchet_messages'
    `.execute(db);
    assert.equal(rows.length, 1, "the listening connection should be found");

    // It tells its subscribers to look for work once it is back.
    await until(() => received.some((m) => m.type === "step_ready"));
    await sender.publish({ type: "run_cancelled", runId: "after-reconnect" });

    await until(() => received.some((m) => m.type === "run_cancelled"));
  } finally {
    await sender.close();
    await receiver.close();
  }
});

test("a worker with no timer of its own runs a new run as soon as an orchestrator relays its message", async () => {
  const notified = defineWorkflow({
    name: "notified",
    version: "1",
    run: (ctx) => ctx.step("only", () => "done"),
  });
  const settings = { timeoutMs: 60_000 };
  const workerEngine = createWorkflowEngine({
    workflows: [notified],
    store: sharedStore,
    messageBroker: createPostgresMessageBroker(),
    settings,
  });
  const orchestratorEngine = createWorkflowEngine({
    workflows: [notified],
    store: sharedStore,
    messageBroker: createPostgresMessageBroker(),
    settings,
  });
  await workerEngine.sync();
  const worker = workerEngine.runWorker({ workerId: "patient" });
  const orchestrator = orchestratorEngine.runOrchestrator();
  try {
    // Long enough for the worker to find nothing and settle into waiting.
    await sleep(300);

    const runId = await workerEngine.startRun({ workflow: "notified" });

    await waitForFinish([runId], 2000);
  } finally {
    await workerEngine.close();
    await orchestratorEngine.close();
    await worker;
    await orchestrator;
  }
});

test("a worker with no timer of its own retries a step as soon as its backoff is over", async () => {
  const retried = defineWorkflow({
    name: "retried",
    version: "1",
    run: (ctx) =>
      ctx.step(
        "only",
        (step) => {
          if (step.attempt === 1) throw new Error("first attempt fails");
          return step.attempt;
        },
        { backoffMs: 200 },
      ),
  });
  const settings = { timeoutMs: 60_000 };
  const workerEngine = createWorkflowEngine({
    workflows: [retried],
    store: sharedStore,
    messageBroker: createPostgresMessageBroker(),
    settings,
  });
  const orchestratorEngine = createWorkflowEngine({
    workflows: [retried],
    store: sharedStore,
    messageBroker: createPostgresMessageBroker(),
    settings,
  });
  await workerEngine.sync();
  const worker = workerEngine.runWorker({ workerId: "patient-retrier" });
  const orchestrator = orchestratorEngine.runOrchestrator();
  try {
    await sleep(300);

    const runId = await workerEngine.startRun({ workflow: "retried" });

    await waitForFinish([runId], 2000);
    const step = await db
      .selectFrom("step_runs")
      .select(["status", "attempt"])
      .where("run_id", "=", runId)
      .executeTakeFirstOrThrow();
    assert.deepEqual(step, { status: "succeeded", attempt: 2 });
  } finally {
    await workerEngine.close();
    await orchestratorEngine.close();
    await worker;
    await orchestrator;
  }
});

test("a polling broker has a worker look for work on its timer, with no orchestrator", async () => {
  const polled = defineWorkflow({
    name: "polled",
    version: "1",
    run: (ctx) => ctx.step("only", () => "done"),
  });
  /** A worker over a polling broker with this interval, and a run started once it is waiting. */
  async function startWith(everyMs: number) {
    const engine = createWorkflowEngine({
      workflows: [polled],
      store: sharedStore,
      messageBroker: createPollingMessageBroker({ everyMs }),
      settings: { timeoutMs: 60_000 },
    });
    await engine.sync();
    const worker = engine.runWorker({ workerId: `polls-every-${everyMs}` });
    await sleep(300);
    const runId = await engine.startRun({ workflow: "polled" });
    return { engine, worker, runId };
  }

  // Told to look once a minute, the worker leaves the run where it is.
  const slow = await startWith(60_000);
  await sleep(500);
  const run = await db
    .selectFrom("workflow_runs")
    .select("status")
    .where("id", "=", slow.runId)
    .executeTakeFirstOrThrow();
  assert.equal(run.status, "queued");
  await slow.engine.close();
  await slow.worker;

  // Told to look every 20ms, another worker runs both runs.
  const quick = await startWith(20);
  await waitForFinish([slow.runId, quick.runId], 2000);
  await quick.engine.close();
  await quick.worker;
});

test("a polling broker carries nothing that is published", async () => {
  const broker = createPollingMessageBroker({ everyMs: 60_000 });
  const received: EngineMessage[] = [];
  await broker.subscribe((message) => received.push(message));

  await broker.publish({ type: "run_cancelled", runId: "run-1" });
  await sleep(20);

  assert.deepEqual(received, []);
  await broker.close();
});

/** Runs one step that waits for its abort signal on a worker over a fake store and a local broker. */
async function runWaitingStep() {
  let signalled = false;
  const waiting = defineWorkflow({
    name: "waiting",
    version: "1",
    run: (ctx) =>
      ctx.step("waiting", async (step) => {
        await new Promise<void>((resolve) =>
          step.abortSignal.addEventListener("abort", () => resolve(), { once: true }),
        );
        signalled = true;
      }),
  });
  const { store: fake, calls } = fakeStore({ workflow: "waiting" });
  const broker = localBroker();
  const engine = createWorkflowEngine({
    workflows: [waiting],
    store: fake,
    messageBroker: broker,
    settings: { timeoutMs: 60_000 },
  });
  const worker = engine.runWorker();
  await until(() => calls.claims === 1);
  // Let the step's function start.
  await sleep(20);
  return { broker, calls, engine, worker, signalled: () => signalled };
}

test("a run_cancelled message makes a worker check its step, and stop it if the store took it away", async () => {
  const { broker, calls, engine, worker, signalled } = await runWaitingStep();
  // The fake store's lease is 30s, so no heartbeat is due for 10s.
  assert.equal(calls.heartbeats, 0);

  calls.owned = false;
  await broker.publish({ type: "run_cancelled", runId: "run" });

  await until(signalled);
  assert.equal(calls.heartbeats, 1);
  await engine.close();
  await worker;
});

test("a run_cancelled message can't stop a step the store says the worker still owns", async () => {
  const { broker, calls, engine, worker, signalled } = await runWaitingStep();

  // A repeat, or one from before the run was redriven: the store's answer decides.
  await broker.publish({ type: "run_cancelled", runId: "run" });
  // And one about another run isn't even checked.
  await broker.publish({ type: "run_cancelled", runId: "another-run" });

  await until(() => calls.heartbeats === 1);
  await sleep(50);
  assert.equal(calls.heartbeats, 1);
  assert.equal(signalled(), false);

  // Take it away for real, so the step ends and the worker can stop.
  calls.owned = false;
  await broker.publish({ type: "run_cancelled", runId: "run" });
  await until(signalled);
  await engine.close();
  await worker;
});

test("an engine can't be created without a message broker", () => {
  const { store: fake } = fakeStore({ workflow: "any" });
  assert.throws(
    () =>
      createWorkflowEngine({
        workflows: [],
        store: fake,
        messageBroker: undefined as never,
        settings: { timeoutMs: 1000 },
      }),
    /needs a messageBroker/,
  );
});

test("closing the engine closes its message broker", async () => {
  const { store: fake } = fakeStore({ workflow: "any" });
  let closed = 0;
  const engine = createWorkflowEngine({
    workflows: [],
    store: fake,
    messageBroker: { ...localBroker(), close: async () => void closed++ },
    settings: { timeoutMs: 1000 },
  });

  await engine.close();
  await engine.close();

  assert.equal(closed, 1);
});
