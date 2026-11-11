import assert from "node:assert/strict";
import { test } from "node:test";
import { stepDisplayStatus } from "../src/utils/steps.ts";

test("a ready step that has never run is ready", () => {
  assert.equal(stepDisplayStatus({ status: "ready", attempt: 0 }), "ready");
});

test("a ready step that has already run is retrying", () => {
  assert.equal(stepDisplayStatus({ status: "ready", attempt: 1 }), "retrying");
  assert.equal(stepDisplayStatus({ status: "ready", attempt: 3 }), "retrying");
});

test("every other status shows as it is", () => {
  for (const status of ["pending", "running", "succeeded", "failed", "skipped"] as const) {
    assert.equal(stepDisplayStatus({ status, attempt: 2 }), status);
  }
});
