// The engine's checks of schedule requests. They run before the store is
// reached, so these need no database or workers.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkflowEngine, defineWorkflow, UnknownWorkflowError } from "../src/index.ts";
import { fakeStore } from "./fakeStore.ts";

const report = defineWorkflow({
  name: "report",
  steps: [{ name: "build", run: async () => {} }],
});

/** An engine with one workflow, "report", over a store that counts the schedule calls it gets. */
function engineWithFakeStore() {
  const { store, calls } = fakeStore({ workflow: "report" });
  return {
    engine: createWorkflowEngine({ workflows: [report], store, settings: { timeoutMs: 60_000 } }),
    calls,
  };
}

test("create passes a valid cron schedule to the store", async () => {
  const { engine, calls } = engineWithFakeStore();

  assert.equal(
    await engine.schedules.create({ workflow: "report", name: "nightly", cron: "0 2 * * *" }),
    true,
  );
  assert.equal(calls.scheduleCalls, 1);
});

test("create rejects an unknown workflow", async () => {
  const { engine, calls } = engineWithFakeStore();

  await assert.rejects(
    engine.schedules.create({ workflow: "nope", name: "nightly", cron: "0 2 * * *" }),
    UnknownWorkflowError,
  );
  assert.equal(calls.scheduleCalls, 0);
});

test("create rejects an empty name", async () => {
  const { engine, calls } = engineWithFakeStore();

  await assert.rejects(
    engine.schedules.create({ workflow: "report", name: " ", cron: "0 2 * * *" }),
    { message: "A schedule needs a name" },
  );
  assert.equal(calls.scheduleCalls, 0);
});

test("create rejects a bad cron and one that never fires", async () => {
  const { engine, calls } = engineWithFakeStore();

  await assert.rejects(
    engine.schedules.create({ workflow: "report", name: "bad", cron: "61 * * * *" }),
    /minute 61 is out of range/,
  );
  await assert.rejects(
    engine.schedules.create({ workflow: "report", name: "never", cron: "0 0 31 2 *" }),
    /never fires/,
  );
  assert.equal(calls.scheduleCalls, 0);
});

test("create rejects both cron and at, and neither", async () => {
  const { engine, calls } = engineWithFakeStore();
  const at = new Date(Date.now() + 3_600_000);

  await assert.rejects(
    engine.schedules.create({ workflow: "report", name: "both", cron: "0 2 * * *", at }),
    { message: "A schedule needs exactly one of `cron` and `at`" },
  );
  await assert.rejects(engine.schedules.create({ workflow: "report", name: "neither" }), {
    message: "A schedule needs exactly one of `cron` and `at`",
  });
  assert.equal(calls.scheduleCalls, 0);
});

test("create rejects an at that is not a date", async () => {
  const { engine, calls } = engineWithFakeStore();

  await assert.rejects(
    engine.schedules.create({ workflow: "report", name: "bad-at", at: new Date("nonsense") }),
    { message: "A schedule's `at` isn't a valid date" },
  );
  assert.equal(calls.scheduleCalls, 0);
});

test("update rejects an unknown workflow, an empty name, a bad cron and no change at all", async () => {
  const { engine, calls } = engineWithFakeStore();

  await assert.rejects(
    engine.schedules.update({ workflow: "nope", name: "nightly", cron: "0 2 * * *" }),
    UnknownWorkflowError,
  );
  await assert.rejects(engine.schedules.update({ workflow: "report", name: "", input: {} }), {
    message: "A schedule needs a name",
  });
  await assert.rejects(
    engine.schedules.update({ workflow: "report", name: "nightly", cron: "0 0 31 2 *" }),
    /never fires/,
  );
  await assert.rejects(engine.schedules.update({ workflow: "report", name: "nightly" }), {
    message: "An update needs at least one of `cron`, `at` and `input`",
  });
  assert.equal(calls.scheduleCalls, 0);
});

test("update rejects both cron and at", async () => {
  const { engine, calls } = engineWithFakeStore();

  await assert.rejects(
    engine.schedules.update({
      workflow: "report",
      name: "nightly",
      cron: "0 2 * * *",
      at: new Date(Date.now() + 3_600_000),
    }),
    { message: "A schedule has either `cron` or `at`, not both" },
  );
  assert.equal(calls.scheduleCalls, 0);
});

test("delete, pause and resume reject an unknown workflow and an empty name", async () => {
  const { engine, calls } = engineWithFakeStore();

  for (const method of ["delete", "pause", "resume"] as const) {
    await assert.rejects(
      engine.schedules[method]({ workflow: "nope", name: "x" }),
      UnknownWorkflowError,
    );
    await assert.rejects(engine.schedules[method]({ workflow: "report", name: "" }), {
      message: "A schedule needs a name",
    });
  }
  assert.equal(calls.scheduleCalls, 0);
});
