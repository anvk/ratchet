import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAge, formatDuration } from "../src/utils/format.ts";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");

/** An ISO timestamp this many seconds before NOW. */
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

/** formatDuration at NOW. */
const duration = (start: string | null, end: string | null) =>
  formatDuration({ start, end, now: NOW });

test("formatDuration shows a dash before something has started", () => {
  assert.equal(duration(null, null), "–");
});

test("formatDuration shows seconds with one decimal under a minute", () => {
  assert.equal(duration(ago(10), ago(6.5)), "3.5s");
  assert.equal(duration(ago(1), ago(1)), "0.0s");
});

test("formatDuration shows minutes and seconds from a minute up", () => {
  assert.equal(duration(ago(200), ago(60)), "2m 20s");
});

test("formatDuration never shows 60 seconds", () => {
  assert.equal(duration(ago(119.6), ago(0)), "2m 0s");
});

test("formatDuration counts up to now while something is still running", () => {
  assert.equal(duration(ago(4.2), null), "4.2s");
  // A later `now` gives a longer duration: the value isn't fixed at the start.
  assert.equal(formatDuration({ start: ago(4.2), end: null, now: NOW + 3000 }), "7.2s");
});

test("formatDuration never goes negative, even if the clocks disagree", () => {
  assert.equal(duration(ago(0), ago(5)), "0.0s");
});

test("formatAge shows a dash without a time", () => {
  assert.equal(formatAge({ at: null, now: NOW }), "–");
});

test("formatAge picks the largest whole unit", () => {
  const age = (seconds: number) => formatAge({ at: ago(seconds), now: NOW });
  assert.equal(age(5), "5s ago");
  assert.equal(age(59), "59s ago");
  assert.equal(age(60), "1m ago");
  assert.equal(age(3599), "59m ago");
  assert.equal(age(3600), "1h ago");
  assert.equal(age(86_399), "23h ago");
  assert.equal(age(86_400), "1d ago");
  assert.equal(age(10 * 86_400), "10d ago");
});

test("formatAge treats a time in the future as just now", () => {
  assert.equal(formatAge({ at: ago(-30), now: NOW }), "0s ago");
});
