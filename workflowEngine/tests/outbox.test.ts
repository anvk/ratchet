import { advanceAll, advanceFor, startWorkers, stopWorkers, store } from "./harness.ts";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { EngineMessage, StepDefaults } from "../src/index.ts";
import { db } from "../src/stores/postgres/index.ts";
import { diamond, pipeline } from "./fixtures/workflows.ts";

// No workers and no orchestrator: these tests drive the store by hand and look
// at what it leaves in the outbox, so nothing else may claim a step or relay.
before(() => startWorkers(0));
after(() => stopWorkers());

beforeEach(async () => {
  await db.deleteFrom("workflow_runs").execute();
  await db.deleteFrom("outbox").execute();
});

const defaults: StepDefaults = {
  leaseMs: 60_000,
  maxAttempts: 3,
  backoffMs: 1000,
  maxBackoffMs: 30_000,
};

/** The messages waiting in the outbox, oldest first. */
const waiting = () => db.selectFrom("outbox").select(["type", "run_id"]).orderBy("id").execute();

/** Empties the outbox, so a test sees only what its next call leaves. */
const clearOutbox = () => db.deleteFrom("outbox").execute();

/** Claims the one ready step there is. */
async function claim(overrides: Partial<StepDefaults> = {}) {
  const claimed = await store.claimStep({
    workerId: "by-hand",
    workflows: [pipeline, diamond],
    order: "fair",
    defaults: { ...defaults, ...overrides },
  });
  assert.ok(claimed, "there should be a step to claim");
  return claimed;
}

/** The engine's side of the store calls that run a workflow's code. */
const advance = advanceFor([pipeline, diamond]);

/** Starts a run and advances it, as a worker would, so its first step is ready to claim. */
async function startAndAdvance(definition: typeof pipeline | typeof diamond) {
  const runId = await store.startRun({ definition });
  await advanceAll([pipeline, diamond]);
  return runId;
}

/** A publish function that records what it is given. */
function recorder() {
  const published: EngineMessage[] = [];
  return { published, publish: async (message: EngineMessage) => void published.push(message) };
}

test("starting a run saves one step_ready message, and so does the advance that asks for its first step", async () => {
  await store.startRun({ definition: pipeline });
  // For the run itself: a worker has to run its code before there is any step.
  assert.deepEqual(await waiting(), [{ type: "step_ready", run_id: null }]);
  await clearOutbox();

  assert.equal(await store.advanceRun({ workflows: [pipeline], advance }), true);
  assert.deepEqual(await waiting(), [{ type: "step_ready", run_id: null }]);
  await clearOutbox();

  // Nothing is marked any more, so there is nothing to advance and nothing to say.
  assert.equal(await store.advanceRun({ workflows: [pipeline], advance }), false);
  assert.deepEqual(await waiting(), []);
});

test("a repeated idempotency key, which starts nothing, saves no message", async () => {
  await store.startRun({ definition: pipeline, idempotencyKey: "outbox-once" });
  await clearOutbox();

  await store.startRun({ definition: pipeline, idempotencyKey: "outbox-once" });

  assert.deepEqual(await waiting(), []);
});

test("finishing a step saves a message for the step the workflow asks for next, unless the worker takes that step itself", async () => {
  await startAndAdvance(pipeline);
  await clearOutbox();

  const first = await claim();
  await store.completeStep({
    claim: first,
    output: { total: 1 },
    claimNext: false,
    defaults,
    advance,
  });
  assert.deepEqual(await waiting(), [{ type: "step_ready", run_id: null }]);
  await clearOutbox();

  // Sticky: the worker takes "third" in the same transaction, so there is
  // nothing for another worker to be told about.
  const second = await claim();
  const { next } = await store.completeStep({
    claim: second,
    output: { total: 2 },
    claimNext: true,
    defaults,
    advance,
  });
  assert.equal(next?.stepName, "third");
  assert.deepEqual(await waiting(), []);
});

test("a sticky worker whose step leads to two more saves a message for the one it leaves", async () => {
  await startAndAdvance(diamond);
  await clearOutbox();

  const start = await claim();
  const { next } = await store.completeStep({
    claim: start,
    output: { n: 1 },
    claimNext: true,
    defaults,
    advance,
  });

  assert.equal(next?.stepName, "left");
  assert.deepEqual(await waiting(), [{ type: "step_ready", run_id: null }]);
});

test("a retry's message is held back until its backoff is over", async () => {
  await startAndAdvance(pipeline);
  await clearOutbox();

  const first = await claim();
  const { retryInMs } = await store.failStep({
    claim: first,
    error: "glitch",
    final: null,
    defaults: { ...defaults, backoffMs: 300 },
    advance,
  });
  assert.ok(retryInMs !== null && retryInMs >= 240);

  // Saved with the retry, but not the relay's to send yet.
  const { published, publish } = recorder();
  assert.equal(await store.relayMessages({ publish }), 0);
  assert.deepEqual(published, []);
  assert.deepEqual(await waiting(), [{ type: "step_ready", run_id: null }]);

  await sleep(retryInMs + 50);
  assert.equal(await store.relayMessages({ publish }), 1);
  assert.deepEqual(published, [{ type: "step_ready" }]);
  // By then the step is claimable.
  assert.equal((await claim()).attempt, 2);
});

test("a swept step saves a step_ready message", async () => {
  await startAndAdvance(pipeline);
  await claim({ leaseMs: 1 });
  await clearOutbox();
  await sleep(20);

  assert.equal(await store.sweepExpiredLeases({ defaults }), 1);

  assert.deepEqual(await waiting(), [{ type: "step_ready", run_id: null }]);
});

test("cancelling a run with a running step saves a run_cancelled message, and redriving it a step_ready one", async () => {
  const runId = await startAndAdvance(pipeline);
  await claim();
  await clearOutbox();

  assert.equal(await store.cancelRun({ runId }), true);
  assert.deepEqual(await waiting(), [{ type: "run_cancelled", run_id: runId }]);
  await clearOutbox();

  assert.equal(await store.redriveRun({ runId }), true);
  assert.deepEqual(await waiting(), [{ type: "step_ready", run_id: null }]);
});

test("cancelling a run with nothing running saves no message", async () => {
  const runId = await startAndAdvance(pipeline);
  await clearOutbox();

  assert.equal(await store.cancelRun({ runId }), true);

  assert.deepEqual(await waiting(), []);
});

test("the relay publishes what is waiting and empties the outbox", async () => {
  const runId = await startAndAdvance(pipeline);
  await claim();
  await store.cancelRun({ runId });
  const saved = (await waiting()).length;
  const { published, publish } = recorder();

  assert.equal(await store.relayMessages({ publish }), saved);

  assert.deepEqual(published, [{ type: "run_cancelled", runId }, { type: "step_ready" }]);
  assert.deepEqual(await waiting(), []);
  assert.equal(await store.relayMessages({ publish }), 0);
});

test("a step that fails for good with no attempts left saves a message only if the workflow asks for more", async () => {
  await startAndAdvance(pipeline);
  const first = await claim();
  await clearOutbox();

  // The pipeline doesn't catch it, so the run fails and there is nothing to claim.
  const { failureReason } = await store.failStep({
    claim: first,
    error: "No",
    final: "non_retryable",
    defaults,
    advance,
  });

  assert.equal(failureReason, "non_retryable");
  assert.deepEqual(await waiting(), []);
});

test("a step that loses its worker for good marks its run to be advanced, with a message", async () => {
  const runId = await startAndAdvance(pipeline);
  await claim({ leaseMs: 1, maxAttempts: 1 });
  await clearOutbox();
  await sleep(20);

  assert.equal(await store.sweepExpiredLeases({ defaults: { ...defaults, maxAttempts: 1 } }), 1);

  // The orchestrator has no code to run, so a worker must: the run is marked, not failed.
  assert.deepEqual(await waiting(), [{ type: "step_ready", run_id: null }]);
  const marked = await db
    .selectFrom("workflow_runs")
    .select(["status", "advance_at"])
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  assert.equal(marked.status, "running");
  assert.notEqual(marked.advance_at, null);

  await advanceAll([pipeline]);
  const run = await db
    .selectFrom("workflow_runs")
    .select(["status", "failure_reason", "advance_at"])
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  assert.deepEqual(run, { status: "failed", failure_reason: "lost_worker", advance_at: null });
});

test("a publish that throws leaves the messages for the next relay", async () => {
  await store.startRun({ definition: pipeline });

  await assert.rejects(
    store.relayMessages({
      publish: async () => {
        throw new Error("broker is down");
      },
    }),
    /broker is down/,
  );
  assert.equal((await waiting()).length, 1);

  const { published, publish } = recorder();
  assert.equal(await store.relayMessages({ publish }), 1);
  assert.deepEqual(published, [{ type: "step_ready" }]);
});

test("a long backlog is relayed as a few messages", async () => {
  await db
    .insertInto("outbox")
    .values(Array.from({ length: 2500 }, () => ({ type: "step_ready" })))
    .execute();
  const { published, publish } = recorder();

  assert.equal(await store.relayMessages({ publish }), 2500);

  assert.ok(published.length <= 3, `${published.length} messages for 2500 rows`);
  assert.deepEqual(await waiting(), []);
});

test("relays racing each other publish each message once", async () => {
  const runIds = Array.from({ length: 50 }, () => crypto.randomUUID());
  await db
    .insertInto("outbox")
    .values(runIds.map((run_id) => ({ type: "run_cancelled", run_id })))
    .execute();
  const { published, publish } = recorder();

  await Promise.all(Array.from({ length: 20 }, () => store.relayMessages({ publish })));

  const cancelled = published.map((m) => (m.type === "run_cancelled" ? m.runId : "")).sort();
  assert.deepEqual(cancelled, [...runIds].sort());
  assert.deepEqual(await waiting(), []);
});
