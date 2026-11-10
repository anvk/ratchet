// Plain functions, so these need no database or workers.

import assert from "node:assert/strict";
import { test } from "node:test";
import { WORKFLOW_RUN_STATUSES } from "../src/workflowEngine.constants.ts";
import { assertUnique, isRunFinished } from "../src/workflowEngine.utils.ts";

test("assertUnique accepts names that are all different", () => {
  assert.doesNotThrow(() => assertUnique(["a", "b", "c"], "step"));
});

test("assertUnique accepts an empty list", () => {
  assert.doesNotThrow(() => assertUnique([], "step"));
});

test("assertUnique names the first duplicate and what it is", () => {
  assert.throws(() => assertUnique(["a", "b", "a", "b"], "workflow"), {
    message: "Duplicate workflow: a",
  });
});

test("assertUnique compares names exactly", () => {
  assert.doesNotThrow(() => assertUnique(["Step", "step", "step "], "step"));
});

test("isRunFinished is true only for succeeded and failed", () => {
  const finished = WORKFLOW_RUN_STATUSES.filter(isRunFinished);
  assert.deepEqual(finished.sort(), ["failed", "succeeded"]);
});
