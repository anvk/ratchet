import assert from "node:assert/strict";
import { test } from "node:test";
import { WORKFLOW_RUN_STATUSES } from "@ratchet/engine/constants";
import { isRunFinished } from "../src/utils/runs.ts";

test("isRunFinished is true only for succeeded and failed", () => {
  const finished = WORKFLOW_RUN_STATUSES.filter(isRunFinished);
  assert.deepEqual(finished.sort(), ["failed", "succeeded"]);
});
