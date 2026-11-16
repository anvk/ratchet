// Plain functions, so these need no database or workers.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ENGINE_SETTINGS } from "../src/workflowEngine.constants.ts";
import {
  ancestors,
  assertCronFires,
  assertUnique,
  canRedrive,
  dependents,
  nextFireAfter,
  parseCron,
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

test("canRedrive allows cancelled runs and failures that a fix could cure, not decisions", () => {
  assert.equal(canRedrive("cancelled", null), true);
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

/** The values a field allows, sorted. */
const sorted = (values: Set<number>) => [...values].sort((a, b) => a - b);

/** The numbers from `from` to `to`, inclusive. */
const span = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

test("parseCron allows every value of every field for five stars", () => {
  const cron = parseCron("* * * * *");
  assert.deepEqual(sorted(cron.minutes), span(0, 59));
  assert.deepEqual(sorted(cron.hours), span(0, 23));
  assert.deepEqual(sorted(cron.daysOfMonth), span(1, 31));
  assert.deepEqual(sorted(cron.months), span(1, 12));
  assert.deepEqual(sorted(cron.daysOfWeek), span(0, 6));
  assert.equal(cron.anyDayOfMonth, true);
  assert.equal(cron.anyDayOfWeek, true);
});

test("parseCron reads single values", () => {
  const cron = parseCron("5 4 3 2 1");
  assert.deepEqual(sorted(cron.minutes), [5]);
  assert.deepEqual(sorted(cron.hours), [4]);
  assert.deepEqual(sorted(cron.daysOfMonth), [3]);
  assert.deepEqual(sorted(cron.months), [2]);
  assert.deepEqual(sorted(cron.daysOfWeek), [1]);
});

test("parseCron reads lists", () => {
  assert.deepEqual(sorted(parseCron("0,15,30 * * * *").minutes), [0, 15, 30]);
});

test("parseCron reads ranges, endpoints included", () => {
  assert.deepEqual(sorted(parseCron("* 9-12 * * *").hours), [9, 10, 11, 12]);
});

test("parseCron reads a step on a star", () => {
  assert.deepEqual(sorted(parseCron("*/15 * * * *").minutes), [0, 15, 30, 45]);
});

test("parseCron reads a step on a range", () => {
  assert.deepEqual(sorted(parseCron("10-30/10 * * * *").minutes), [10, 20, 30]);
});

test("parseCron reads a step on a value as from that value to the field's maximum", () => {
  assert.deepEqual(sorted(parseCron("5/20 * * * *").minutes), [5, 25, 45]);
});

test("parseCron reads lists that mix values, ranges and steps", () => {
  assert.deepEqual(sorted(parseCron("1,15,30-40/5 * * * *").minutes), [1, 15, 30, 35, 40]);
});

test("parseCron reads 7 in day of week as Sunday", () => {
  assert.deepEqual(sorted(parseCron("* * * * 7").daysOfWeek), [0]);
});

test("parseCron reads 0,7 in day of week as just Sunday", () => {
  assert.deepEqual(sorted(parseCron("* * * * 0,7").daysOfWeek), [0]);
});

test("parseCron accepts extra spaces and tabs between fields", () => {
  const cron = parseCron("  0 \t 2   *\t*  * ");
  assert.deepEqual(sorted(cron.minutes), [0]);
  assert.deepEqual(sorted(cron.hours), [2]);
});

test("parseCron marks a restricted day field as not any", () => {
  const cron = parseCron("0 0 13 * 5");
  assert.equal(cron.anyDayOfMonth, false);
  assert.equal(cron.anyDayOfWeek, false);
});

test("parseCron counts a step on a star as restricted", () => {
  const cron = parseCron("0 0 */2 * */3");
  assert.equal(cron.anyDayOfMonth, false);
  assert.equal(cron.anyDayOfWeek, false);
});

test("parseCron rejects the wrong number of fields and says how many it found", () => {
  assert.throws(() => parseCron("* * * *"), /found 4 fields, but five are needed/);
  assert.throws(() => parseCron("* * * * * *"), /found 6 fields, but five are needed/);
  assert.throws(() => parseCron(""), /found 0 fields, but five are needed/);
});

test("parseCron rejects a value out of range and names the field", () => {
  assert.throws(() => parseCron("61 * * * *"), /minute 61 is out of range 0-59/);
  assert.throws(() => parseCron("* 24 * * *"), /hour 24 is out of range 0-23/);
  assert.throws(() => parseCron("* * 0 * *"), /day of month 0 is out of range 1-31/);
  assert.throws(() => parseCron("* * * 13 *"), /month 13 is out of range 1-12/);
  assert.throws(() => parseCron("* * * * 8"), /day of week 8 is out of range 0-7/);
});

test("parseCron rejects the end of a range that is out of range", () => {
  assert.throws(() => parseCron("0-60 * * * *"), /minute 60 is out of range 0-59/);
});

test("parseCron rejects a range that starts after it ends", () => {
  assert.throws(() => parseCron("* 20-10 * * *"), /hour range 20-10 starts after it ends/);
});

test("parseCron rejects a step that is not a positive whole number", () => {
  assert.throws(() => parseCron("*/0 * * * *"), /minute step "0" must be a positive whole number/);
  assert.throws(() => parseCron("* */1.5 * * *"), /hour step "1.5" must be a positive whole/);
  assert.throws(() => parseCron("* * */-2 * *"), /day of month step "-2" must be a positive whole/);
  assert.throws(() => parseCron("* * * */ *"), /month step "" must be a positive whole/);
});

test("parseCron rejects an empty list item", () => {
  assert.throws(() => parseCron("1,,2 * * * *"), /minute has an empty item/);
  assert.throws(() => parseCron("* 1, * * *"), /hour has an empty item/);
});

test("parseCron rejects forms it does not support, naming the field", () => {
  assert.throws(() => parseCron("* * * * MON"), /day of week "MON" isn't supported/);
  assert.throws(() => parseCron("* * * JAN *"), /month "JAN" isn't supported/);
  assert.throws(() => parseCron("@daily"), /found 1 fields/);
  assert.throws(() => parseCron("? * * * *"), /minute "\?" isn't supported/);
  assert.throws(() => parseCron("* * L * *"), /day of month "L" isn't supported/);
  assert.throws(() => parseCron("* * 15W * *"), /day of month "15W" isn't supported/);
  assert.throws(() => parseCron("* * * * 5#2"), /day of week "5#2" isn't supported/);
  assert.throws(() => parseCron("-5 * * * *"), /minute "-5" isn't supported/);
  assert.throws(() => parseCron("1.5 * * * *"), /minute "1.5" isn't supported/);
});

/** A UTC date for a test, with the month counted from 1. */
const utc = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0) =>
  new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));

/** The ISO text of the next fire, so a failure shows readable dates. */
const next = (cron: string, after: Date) => nextFireAfter({ cron, after }).toISOString();

test("nextFireAfter moves to the next minute for every-minute", () => {
  assert.equal(next("* * * * *", utc(2026, 11, 13, 10, 15, 30)), "2026-11-13T10:16:00.000Z");
});

test("nextFireAfter never returns the instant it was given", () => {
  assert.equal(next("* * * * *", utc(2026, 11, 13, 10, 16)), "2026-11-13T10:17:00.000Z");
});

test("nextFireAfter finds a later time on the same day", () => {
  assert.equal(next("0 2 * * *", utc(2026, 11, 13, 1, 59)), "2026-11-13T02:00:00.000Z");
});

test("nextFireAfter goes to the next day when the time has already passed", () => {
  assert.equal(next("0 2 * * *", utc(2026, 11, 13, 2, 0)), "2026-11-14T02:00:00.000Z");
});

test("nextFireAfter honours steps", () => {
  assert.equal(next("*/15 * * * *", utc(2026, 11, 13, 10, 50)), "2026-11-13T11:00:00.000Z");
});

test("nextFireAfter skips the weekend for Monday to Friday", () => {
  // 2026-11-13 is a Friday, 2026-11-16 the Monday after.
  assert.equal(next("0 9 * * 1-5", utc(2026, 11, 13, 18)), "2026-11-16T09:00:00.000Z");
});

test("nextFireAfter finds the first of the next month", () => {
  assert.equal(next("0 0 1 * *", utc(2026, 11, 15)), "2026-12-01T00:00:00.000Z");
});

test("nextFireAfter rolls over the year", () => {
  assert.equal(next("0 0 1 * *", utc(2026, 12, 15)), "2027-01-01T00:00:00.000Z");
});

test("nextFireAfter waits for the next leap year for 29 February", () => {
  assert.equal(next("0 0 29 2 *", utc(2026, 3, 1)), "2028-02-29T00:00:00.000Z");
});

test("nextFireAfter takes the earlier of the day of month and the day of week when both are set", () => {
  // 2026-11-01 is a Sunday, so the first Friday is the 6th, before the 13th.
  assert.equal(next("0 0 13 * 5", utc(2026, 11, 1)), "2026-11-06T00:00:00.000Z");
});

test("nextFireAfter reaches the 13th when it comes before the next Friday", () => {
  // 2026-11-07 is a Saturday; the 13th is the Friday after it.
  assert.equal(next("0 0 13 * 5", utc(2026, 11, 7)), "2026-11-13T00:00:00.000Z");
});

test("nextFireAfter moves on to the next Friday after one that is also the 13th", () => {
  assert.equal(next("0 0 13 * 5", utc(2026, 11, 13)), "2026-11-20T00:00:00.000Z");
});

test("nextFireAfter finds the last minute of the year a year later", () => {
  assert.equal(next("30 23 31 12 *", utc(2026, 12, 31, 23, 30)), "2027-12-31T23:30:00.000Z");
});

test("nextFireAfter returns times with zero seconds and milliseconds", () => {
  const found = nextFireAfter({ cron: "7 * * * *", after: utc(2026, 11, 13, 10, 15, 42, 999) });
  assert.equal(found.getUTCSeconds(), 0);
  assert.equal(found.getUTCMilliseconds(), 0);
  assert.equal(found.toISOString(), "2026-11-13T11:07:00.000Z");
});

test("nextFireAfter throws for a date that never exists", () => {
  assert.throws(() => nextFireAfter({ cron: "0 0 31 2 *", after: utc(2026, 1, 1) }), {
    message: 'Cron "0 0 31 2 *" never fires',
  });
});

test("nextFireAfter throws the parse error for a bad expression", () => {
  assert.throws(() => nextFireAfter({ cron: "61 * * * *", after: utc(2026, 1, 1) }), {
    message: 'Cron "61 * * * *": minute 61 is out of range 0-59',
  });
});

test("assertCronFires accepts an expression that fires", () => {
  assert.doesNotThrow(() => assertCronFires("*/30 9-17 * * 1-5"));
});

test("assertCronFires throws the parse error for a bad expression", () => {
  assert.throws(() => assertCronFires("61 * * * *"), {
    message: 'Cron "61 * * * *": minute 61 is out of range 0-59',
  });
});

test("assertCronFires throws for an expression that never fires", () => {
  assert.throws(() => assertCronFires("0 0 31 2 *"), {
    message: 'Cron "0 0 31 2 *" never fires',
  });
});
