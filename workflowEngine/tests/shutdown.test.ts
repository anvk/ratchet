// Uses a fake store, so these need no database. They also show that the engine
// runs against anything implementing WorkflowStore.

import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createWorkflowEngine,
  createPollingMessageBroker,
  defineWorkflow,
  type WorkflowEngine,
  type WorkflowEngineSettings,
} from "../src/index.ts";
import { fakeStore } from "./fakeStore.ts";

/** Starts an engine whose step runs until the returned release function is called. */
async function engineWithRunningStep(settings?: Partial<WorkflowEngineSettings>) {
  const { store, calls } = fakeStore({ workflow: "slow", claims: 2 });
  let started = () => {};
  let release = () => {};
  const stepStarted = new Promise<void>((resolve) => (started = resolve));
  const stepReleased = new Promise<void>((resolve) => (release = resolve));

  const slow = defineWorkflow({
    name: "slow",
    version: "1",
    run: (ctx) =>
      ctx.step("slow", async () => {
        started();
        await stepReleased;
      }),
  });

  const engine: WorkflowEngine = createWorkflowEngine({
    messageBroker: createPollingMessageBroker({ everyMs: 1 }),
    workflows: [slow],
    store,
    settings: { timeoutMs: 60_000, ...settings },
  });
  const worker = engine.runWorker({ workerId: "worker" });
  await stepStarted;
  return { engine, worker, calls, release };
}

test("close waits for the running step, then stops claiming", async () => {
  const { engine, worker, calls, release } = await engineWithRunningStep();

  const closing = engine.close();
  await sleep(30);
  assert.equal(calls.closed, 0, "the store must stay open while a step runs");
  assert.equal(calls.completed, 0);

  release();
  await closing;
  await worker;
  assert.equal(calls.completed, 1, "the running step's result should be saved");
  assert.equal(calls.claims, 1, "no new step should be claimed after close");
  assert.equal(calls.closed, 1);
});

test("force close does not wait for the running step", async () => {
  const { engine, worker, calls, release } = await engineWithRunningStep();

  await engine.close({ force: true });
  assert.equal(calls.closed, 1);
  assert.equal(calls.completed, 0, "the step is still running");

  release();
  await worker;
});

test("close stops waiting after closeTimeoutMs", async () => {
  const { engine, worker, calls, release } = await engineWithRunningStep({ closeTimeoutMs: 20 });

  await engine.close();
  assert.equal(calls.closed, 1, "the store should close once the timeout passes");
  assert.equal(calls.completed, 0, "the step is still running");

  release();
  await worker;
});

test("closing twice only closes the store once", async () => {
  const { engine, worker, calls, release } = await engineWithRunningStep();
  release();
  await Promise.all([engine.close(), engine.close()]);
  await worker;
  assert.equal(calls.closed, 1);
});
