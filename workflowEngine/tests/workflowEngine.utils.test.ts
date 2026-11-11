// Plain functions, so these need no database or workers.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ENGINE_SETTINGS, WORKFLOW_RUN_STATUSES } from "../src/workflowEngine.constants.ts";
import {
  ancestors,
  assertUnique,
  isRunFinished,
  resolveNeeds,
  retryDelayMs,
  stepDefaults,
  stepDepths,
} from "../src/workflowEngine.utils.ts";

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

test("retryDelayMs doubles from backoffMs on each attempt", () => {
  const delay = (attempt: number) =>
    retryDelayMs({ attempt, backoffMs: 1000, maxBackoffMs: 60_000, random: () => 0.5 });
  assert.deepEqual([1, 2, 3, 4].map(delay), [1000, 2000, 4000, 8000]);
});

test("retryDelayMs never goes past maxBackoffMs, before jitter", () => {
  assert.equal(
    retryDelayMs({ attempt: 20, backoffMs: 1000, maxBackoffMs: 30_000, random: () => 0.5 }),
    30_000,
  );
});

test("retryDelayMs spreads delays by up to 20% either way", () => {
  const delay = (random: number) =>
    retryDelayMs({ attempt: 1, backoffMs: 1000, maxBackoffMs: 30_000, random: () => random });
  assert.equal(delay(0), 800);
  assert.equal(delay(0.999_999), 1200);
});

test("stepDefaults picks the step-related settings", () => {
  assert.deepEqual(stepDefaults(DEFAULT_ENGINE_SETTINGS), {
    leaseMs: 30_000,
    maxAttempts: 3,
    backoffMs: 1000,
    maxBackoffMs: 30_000,
  });
});

// receive → validate → (risk, sanctions) → ledger, like the payment workflow.
const diamond = [
  { name: "receive", needs: [] },
  { name: "validate", needs: ["receive"] },
  { name: "risk", needs: ["validate"] },
  { name: "sanctions", needs: ["validate"] },
  { name: "ledger", needs: ["risk", "sanctions"] },
];

test("resolveNeeds makes steps without needs run in order", () => {
  assert.deepEqual(resolveNeeds([{ name: "a" }, { name: "b" }, { name: "c" }]), [
    { name: "a", needs: [] },
    { name: "b", needs: ["a"] },
    { name: "c", needs: ["b"] },
  ]);
});

test("resolveNeeds keeps needs that are given, including none", () => {
  assert.deepEqual(resolveNeeds([{ name: "a" }, { name: "b", needs: [] }, { name: "c" }]), [
    { name: "a", needs: [] },
    { name: "b", needs: [] },
    { name: "c", needs: ["b"] },
  ]);
});

test("ancestors includes steps needed through other steps", () => {
  assert.deepEqual([...ancestors(diamond, "ledger")].sort(), [
    "receive",
    "risk",
    "sanctions",
    "validate",
  ]);
});

test("ancestors leaves out steps running side by side", () => {
  assert.deepEqual([...ancestors(diamond, "risk")].sort(), ["receive", "validate"]);
  assert.equal(ancestors(diamond, "receive").size, 0);
});

test("stepDepths puts parallel steps at the same depth", () => {
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
