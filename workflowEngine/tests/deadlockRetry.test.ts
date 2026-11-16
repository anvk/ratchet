import { startWorkers, stopWorkers } from "./harness.ts";

import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";
import { sql } from "kysely";
import { db } from "../src/stores/postgres/index.ts";
import { retryOnDeadlock } from "../src/stores/postgres/postgres.utils.ts";

// No workers: this only sets up the test database and closes it afterwards.
before(() => startWorkers(0));
after(() => stopWorkers());

/** How many deadlocks Postgres has detected in the test database so far. */
async function deadlockCount() {
  const { rows } = await sql<{
    deadlocks: string;
  }>`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`.execute(db);
  return Number(rows[0].deadlocks);
}

/** Two advisory lock keys nothing else uses. */
const LOCK_ONE = 918_273_645;
const LOCK_TWO = 918_273_646;

test(
  "a transaction aborted by a real deadlock is run again and succeeds",
  { timeout: 30_000 },
  async () => {
    const before = await deadlockCount();

    // On their first attempt, both transactions hold their first lock before
    // either asks for its second, so they are certain to deadlock.
    let holding = 0;
    let bothHolding!: () => void;
    const barrier = new Promise<void>((resolve) => (bothHolding = resolve));
    const runs = { a: 0, b: 0 };

    /** Takes `first`, then `second`, in one transaction, retried on a deadlock. */
    const take = ({ name, first, second }: { name: "a" | "b"; first: number; second: number }) =>
      retryOnDeadlock({
        run: () =>
          db.transaction().execute(async (trx) => {
            const attempt = ++runs[name];
            await sql`SELECT pg_advisory_xact_lock(${first})`.execute(trx);
            if (attempt === 1) {
              if (++holding === 2) bothHolding();
              await barrier;
            }
            await sql`SELECT pg_advisory_xact_lock(${second})`.execute(trx);
            return name;
          }),
      });

    const results = await Promise.all([
      take({ name: "a", first: LOCK_ONE, second: LOCK_TWO }),
      take({ name: "b", first: LOCK_TWO, second: LOCK_ONE }),
    ]);
    assert.deepEqual(results, ["a", "b"]);
    assert.equal(runs.a + runs.b, 3, "one transaction was aborted and run again");

    // The counter can lag a moment.
    const deadline = Date.now() + 3000;
    while ((await deadlockCount()) === before && Date.now() < deadline) await sleep(50);
    assert.equal(await deadlockCount(), before + 1);
  },
);
