import { setTimeout as sleep } from "node:timers/promises";

/** The code Postgres gives a transaction it aborted to break a deadlock. */
export const DEADLOCK_DETECTED = "40P01";

/** Whether an error is Postgres aborting a transaction to break a deadlock. */
export function isDeadlock(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === DEADLOCK_DETECTED;
}

/**
 * Runs `run`, and runs it again if Postgres aborted it to break a deadlock.
 * Postgres breaks a deadlock by aborting one of the transactions involved; that
 * transaction is rolled back in full, so running it again from the start is
 * safe, as long as `run` has no effect outside the transaction. Any other error,
 * and a deadlock after the last retry, is thrown as it is. Each retry waits a
 * random time first, so the two transactions that collided don't collide again
 * in step.
 */
export async function retryOnDeadlock<T>({
  run,
  retries = 3,
  wait = (retry) => sleep(Math.random() * 50 * retry),
}: {
  run: () => Promise<T>;
  /** How many times to run it again after a deadlock. */
  retries?: number;
  /** Waits before retry number `retry` (1, 2, …). Tests pass their own. */
  wait?: (retry: number) => Promise<void>;
}): Promise<T> {
  for (let retry = 1; ; retry++) {
    try {
      return await run();
    } catch (err) {
      if (!isDeadlock(err) || retry > retries) throw err;
      console.warn(`[store] deadlock detected, retrying (${retry} of ${retries})`);
      await wait(retry);
    }
  }
}
