// Plain checks of defineWorkflow, so these need no database or workers.

import assert from "node:assert/strict";
import { test } from "node:test";
import { defineWorkflow, type WorkflowSchedule } from "../src/index.ts";

/** Defines a one-step workflow called "report" with the given schedules. */
const define = (schedules: WorkflowSchedule[]) =>
  defineWorkflow({ name: "report", schedules, steps: [{ name: "build", run: async () => {} }] });

test("defineWorkflow accepts a workflow with valid schedules", () => {
  assert.doesNotThrow(() =>
    define([
      { name: "nightly", cron: "0 2 * * *", input: { ticker: "AAPL" } },
      { name: "weekdays", cron: "*/30 9-17 * * 1-5" },
    ]),
  );
});

test("defineWorkflow accepts an empty list of schedules", () => {
  assert.doesNotThrow(() => define([]));
});

test("defineWorkflow rejects a bad cron and names the schedule", () => {
  assert.throws(
    () => define([{ name: "nightly", cron: "61 * * * *" }]),
    /Schedule report\/nightly: Cron "61 \* \* \* \*": minute 61 is out of range/,
  );
});

test("defineWorkflow rejects a cron that never fires", () => {
  assert.throws(
    () => define([{ name: "never", cron: "0 0 31 2 *" }]),
    /Schedule report\/never: .*never fires/,
  );
});

test("defineWorkflow rejects two schedules with the same name", () => {
  assert.throws(
    () =>
      define([
        { name: "nightly", cron: "0 2 * * *" },
        { name: "nightly", cron: "0 3 * * *" },
      ]),
    { message: "Duplicate schedule in report: nightly" },
  );
});
