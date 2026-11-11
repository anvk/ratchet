import assert from "node:assert/strict";
import { test } from "node:test";
import { QUERY_KEYS } from "../src/queryKeys.ts";

test("every page of the runs list starts with the lists prefix, so one invalidation covers them", () => {
  const prefix = QUERY_KEYS.runs.lists();
  for (const key of [
    QUERY_KEYS.runs.list({ status: "all", cursor: null }),
    QUERY_KEYS.runs.list({ status: "failed", cursor: "abc" }),
  ]) {
    assert.deepEqual(key.slice(0, prefix.length), prefix);
  }
});

test("a run's details and events don't start with the lists prefix", () => {
  const prefix = QUERY_KEYS.runs.lists();
  for (const key of [
    QUERY_KEYS.runs.details({ id: "r1" }),
    QUERY_KEYS.runs.events({ id: "r1", finished: false }),
  ]) {
    assert.notDeepEqual(key.slice(0, prefix.length), prefix);
  }
});

test("each run gets its own keys", () => {
  assert.notDeepEqual(QUERY_KEYS.runs.details({ id: "r1" }), QUERY_KEYS.runs.details({ id: "r2" }));
});

test("a run's events get a new key when it finishes", () => {
  assert.notDeepEqual(
    QUERY_KEYS.runs.events({ id: "r1", finished: false }),
    QUERY_KEYS.runs.events({ id: "r1", finished: true }),
  );
});
