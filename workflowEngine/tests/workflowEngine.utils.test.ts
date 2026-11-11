// Plain functions, so these need no database or workers.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ENGINE_SETTINGS } from "../src/workflowEngine.constants.ts";
import {
  ancestors,
  assertUnique,
  canRedrive,
  dependents,
  resolveNeeds,
  retryDelayMs,
  stepDefaults,
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

test("canRedrive allows failures that a fix could cure, not decisions", () => {
  assert.equal(canRedrive("failed", "attempts_exhausted"), true);
  assert.equal(canRedrive("failed", "lost_worker"), true);
  assert.equal(canRedrive("failed", "unknown_step"), true);
  assert.equal(canRedrive("failed", "non_retryable"), false);
  assert.equal(canRedrive("succeeded", null), false);
  assert.equal(canRedrive("running", null), false);
});

test("dependents includes steps that depend on a step through others", () => {
  assert.deepEqual([...dependents(diamond, "validate")].sort(), ["ledger", "risk", "sanctions"]);
  assert.deepEqual([...dependents(diamond, "risk")], ["ledger"], "not the parallel sanctions");
  assert.equal(dependents(diamond, "ledger").size, 0);
});
