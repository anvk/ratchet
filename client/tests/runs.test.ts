import assert from "node:assert/strict";
import { test } from "node:test";
import { WORKFLOW_RUN_STATUSES } from "@ratchet/engine/constants";
import { isRunFinished } from "../src/utils/runs.ts";

test("isRunFinished is true only for succeeded, failed and cancelled", () => {
  const finished = WORKFLOW_RUN_STATUSES.filter(isRunFinished);
  assert.deepEqual(finished.sort(), ["cancelled", "failed", "succeeded"]);
});
