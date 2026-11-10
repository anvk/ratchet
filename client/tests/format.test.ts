import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { formatAge, formatDuration } from "../src/utils/format.ts";

// Both functions compare against the current time, so the clock is frozen here.
const NOW = Date.parse("2026-11-10T12:00:00.000Z");

/** An ISO timestamp this many seconds before NOW. */
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

beforeEach(() => mock.timers.enable({ apis: ["Date"], now: NOW }));
afterEach(() => mock.timers.reset());

test("formatDuration shows a dash before something has started", () => {
  assert.equal(formatDuration(null, null), "–");
});

test("formatDuration shows seconds with one decimal under a minute", () => {
  assert.equal(formatDuration(ago(10), ago(6.5)), "3.5s");
  assert.equal(formatDuration(ago(1), ago(1)), "0.0s");
});

test("formatDuration shows minutes and seconds from a minute up", () => {
  assert.equal(formatDuration(ago(200), ago(60)), "2m 20s");
});

test("formatDuration never shows 60 seconds", () => {
  assert.equal(formatDuration(ago(119.6), ago(0)), "2m 0s");
});

test("formatDuration counts up to now while something is still running", () => {
  assert.equal(formatDuration(ago(4.2), null), "4.2s");
});

test("formatDuration never goes negative, even if the clocks disagree", () => {
  assert.equal(formatDuration(ago(0), ago(5)), "0.0s");
});

test("formatAge shows a dash without a time", () => {
  assert.equal(formatAge(null), "–");
});

test("formatAge picks the largest whole unit", () => {
  assert.equal(formatAge(ago(5)), "5s ago");
  assert.equal(formatAge(ago(59)), "59s ago");
  assert.equal(formatAge(ago(60)), "1m ago");
  assert.equal(formatAge(ago(3599)), "59m ago");
  assert.equal(formatAge(ago(3600)), "1h ago");
  assert.equal(formatAge(ago(86_399)), "23h ago");
  assert.equal(formatAge(ago(86_400)), "1d ago");
  assert.equal(formatAge(ago(10 * 86_400)), "10d ago");
});

test("formatAge treats a time in the future as just now", () => {
  assert.equal(formatAge(ago(-30)), "0s ago");
});
