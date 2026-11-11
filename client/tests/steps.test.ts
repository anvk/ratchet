import assert from "node:assert/strict";
import { test } from "node:test";
import { stepDepths, stepDisplayStatus } from "../src/utils/steps.ts";

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

test("stepDepths puts steps that run side by side at the same depth", () => {
  const diamond = [
    { name: "receive", needs: [] },
    { name: "validate", needs: ["receive"] },
    { name: "risk", needs: ["validate"] },
    { name: "sanctions", needs: ["validate"] },
    { name: "ledger", needs: ["risk", "sanctions"] },
  ];
  assert.deepEqual(Object.fromEntries(stepDepths(diamond)), {
    receive: 0,
    validate: 1,
    risk: 2,
    sanctions: 2,
    ledger: 3,
  });
});

test("stepDepths uses the furthest step needed", () => {
  const uneven = [
    { name: "a", needs: [] },
    { name: "b", needs: ["a"] },
    { name: "c", needs: ["a", "b"] },
  ];
  assert.deepEqual(Object.fromEntries(stepDepths(uneven)), { a: 0, b: 1, c: 2 });
});
