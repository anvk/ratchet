// Plain functions, so these need no database.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEADLOCK_DETECTED,
  isDeadlock,
  retryOnDeadlock,
} from "../src/stores/postgres/postgres.utils.ts";

/** An error the way Postgres's driver reports one: with its SQLSTATE in `code`. */
const pgError = (code: string) => Object.assign(new Error(`error ${code}`), { code });

/** A `wait` that records what it was called with and resolves at once. */
function recordingWait() {
  const calls: number[] = [];
  return {
    calls,
    wait: async (retry: number) => {
      calls.push(retry);
    },
  };
}

test("retryOnDeadlock returns the result when the first run succeeds", async () => {
  const { calls, wait } = recordingWait();
  let runs = 0;
  const result = await retryOnDeadlock({
    run: async () => {
      runs++;
      return "done";
    },
    wait,
  });
  assert.equal(result, "done");
  assert.equal(runs, 1);
  assert.deepEqual(calls, []);
});

test("retryOnDeadlock runs again after a deadlock", async () => {
  const { calls, wait } = recordingWait();
  let runs = 0;
  const result = await retryOnDeadlock({
    run: async () => {
      runs++;
      if (runs === 1) throw pgError(DEADLOCK_DETECTED);
      return "done";
    },
    wait,
  });
  assert.equal(result, "done");
  assert.equal(runs, 2);
  assert.deepEqual(calls, [1]);
});

test("retryOnDeadlock gives up after its retries and rethrows the deadlock", async () => {
  const { calls, wait } = recordingWait();
  const deadlock = pgError(DEADLOCK_DETECTED);
  let runs = 0;
  await assert.rejects(
    retryOnDeadlock({
      run: async () => {
        runs++;
        throw deadlock;
      },
      retries: 2,
      wait,
    }),
    (err) => err === deadlock,
  );
  assert.equal(runs, 3);
  assert.deepEqual(calls, [1, 2]);
});

test("retryOnDeadlock doesn't retry other errors", async () => {
  for (const error of [new Error("boom"), pgError("23505")]) {
    const { calls, wait } = recordingWait();
    let runs = 0;
    await assert.rejects(
      retryOnDeadlock({
        run: async () => {
          runs++;
          throw error;
        },
        wait,
      }),
      (err) => err === error,
    );
    assert.equal(runs, 1);
    assert.deepEqual(calls, []);
  }
});

test("isDeadlock only recognises Postgres's deadlock code", () => {
  assert.equal(isDeadlock({ code: "40P01" }), true);
  assert.equal(isDeadlock(pgError("40P01")), true);
  assert.equal(isDeadlock({ code: "40001" }), false);
  assert.equal(isDeadlock(new Error("deadlock detected")), false);
  assert.equal(isDeadlock(null), false);
  assert.equal(isDeadlock(undefined), false);
  assert.equal(isDeadlock("40P01"), false);
});
