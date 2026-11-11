// Stub payment operations. No real money or payment provider is involved.
//
// This file knows nothing about the workflow engine. The functions could be
// called from anywhere, and a real integration would replace their insides.

import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";

export type Outcome = "clear" | "insufficient-funds" | "risk-declined" | "sanctions-match";

/**
 * A decision against the payment, such as insufficient funds. Trying again
 * would give the same answer, unlike a timeout, which might pass.
 */
export class PaymentDeclined extends Error {
  override name = "PaymentDeclined";
}

/** Stands in for the outside world: how slow it is, and what it decides. */
export interface Simulation {
  /** Force a result instead of leaving it to chance. */
  forceOutcome?: Outcome;
  /** Multiplies waits and simulation size. 0 runs instantly. */
  timeScale: number;
  /** Ends waits early when it fires, like cancelling a network call. */
  signal?: AbortSignal;
  /** A random-looking number in [min, max) that always repeats for the same label. */
  random(range: { label: string; min: number; max: number }): number;
}

// The ledger has its own connection. allowExitOnIdle lets a stopping worker
// exit without closing it.
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, allowExitOnIdle: true });

pool.on("error", (err) => console.error("idle ledger connection error:", err.message));

/**
 * Builds a Simulation whose numbers depend only on `key` and each label. Put
 * the attempt in the key so a call that fails once won't fail on every retry.
 */
export function createSimulation({
  key,
  forceOutcome,
  timeScale = 1,
  signal,
}: {
  key: string;
  forceOutcome?: Outcome;
  timeScale?: number;
  signal?: AbortSignal;
}): Simulation {
  return {
    forceOutcome,
    timeScale,
    signal,
    random({ label, min, max }) {
      const digest = createHash("sha256").update(`${key}:${label}`).digest();
      return min + (digest.readUInt32BE(0) / 2 ** 32) * (max - min);
    },
  };
}

/** Waits for a random time in the range, like a slow network call. Throws if cancelled. */
function pause({
  simulation,
  minMs,
  maxMs,
}: {
  simulation: Simulation;
  minMs: number;
  maxMs: number;
}) {
  return sleep(
    simulation.random({ label: "pause", min: minMs, max: maxMs }) * simulation.timeScale,
    undefined,
    { signal: simulation.signal },
  );
}

/**
 * Monte Carlo risk score: the percentage of simulated random walks that
 * breach a limit. Deliberately CPU-heavy and synchronous, so it blocks the
 * event loop while it runs.
 */
function simulateRisk({
  paths,
  limitInSigmas,
  seed,
}: {
  paths: number;
  limitInSigmas: number;
  seed: number;
}): number {
  const stepsPerPath = 250;
  const limit = limitInSigmas * Math.sqrt(stepsPerPath);
  let state = seed >>> 0;
  let breaches = 0;

  for (let path = 0; path < paths; path++) {
    let position = 0;
    let peak = 0;
    for (let i = 0; i < stepsPerPath; i++) {
      // mulberry32: a tiny, fast, seedable random number generator.
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      position += ((t ^ (t >>> 14)) >>> 0) % 2 === 0 ? 1 : -1;
      if (Math.abs(position) > peak) peak = Math.abs(position);
    }
    if (peak >= limit) breaches++;
  }
  return Math.round((breaches / paths) * 100);
}

/** Accepts a payment request and fixes its amount and accounts. */
export async function receivePayment({
  paymentId,
  amountCents,
  simulation,
}: {
  paymentId: string;
  amountCents?: number;
  simulation: Simulation;
}) {
  await pause({ simulation, minMs: 500, maxMs: 1000 });
  return {
    paymentId,
    amountCents:
      amountCents ?? Math.round(simulation.random({ label: "amount", min: 1_000, max: 250_000 })),
    from: "acct_sender",
    to: "acct_merchant",
  };
}

/** Checks that the sender can cover the amount, and throws if not. */
export async function validateAccount({
  amountCents,
  simulation,
}: {
  amountCents: number;
  simulation: Simulation;
}) {
  await pause({ simulation, minMs: 1000, maxMs: 3000 });
  const balanceCents = Math.round(
    simulation.random({ label: "balance", min: 100_000, max: 1_000_000 }),
  );
  const forced = simulation.forceOutcome;
  const insufficient = forced ? forced === "insufficient-funds" : amountCents > balanceCents;
  if (insufficient) throw new PaymentDeclined("Insufficient funds");
  return { balanceCents };
}

/**
 * Scores the payment's risk, and throws if the score is above 85. 1 to 2
 * million paths take about 3 to 4.5 seconds of blocked event loop on an Apple
 * Silicon laptop. `overloaded` runs a fixed 8 million (about 18 seconds), like
 * an unusually heavy calculation.
 */
export async function scoreRisk({
  simulation,
  overloaded = false,
}: {
  simulation: Simulation;
  overloaded?: boolean;
}) {
  await pause({ simulation, minMs: 200, maxMs: 500 });
  const forced = simulation.forceOutcome;
  const limitInSigmas =
    forced === "risk-declined"
      ? 0.05
      : forced
        ? 2.5
        : simulation.random({ label: "risk-limit", min: 0, max: 2 });
  const paths =
    simulation.timeScale === 0
      ? 200
      : overloaded
        ? 8_000_000
        : Math.round(simulation.random({ label: "paths", min: 1_000_000, max: 2_000_000 }));
  const score = simulateRisk({
    paths,
    limitInSigmas,
    seed: Math.floor(simulation.random({ label: "simulation", min: 0, max: 2 ** 32 })),
  });
  if (score > 85) throw new PaymentDeclined(`Risk score ${score}: declined`);
  return { score };
}

/**
 * Checks both parties against a fake sanctions list, and throws on a match.
 * The fake vendor is flaky: without a forced outcome, 15% of calls time out,
 * which is worth retrying. `timesOut` forces a timeout.
 */
export async function screenSanctions({
  simulation,
  timesOut = false,
}: {
  simulation: Simulation;
  timesOut?: boolean;
}) {
  await pause({ simulation, minMs: 1000, maxMs: 4000 });
  const forced = simulation.forceOutcome;
  const flaky = !forced && simulation.random({ label: "vendor", min: 0, max: 1 }) < 0.15;
  if (timesOut || flaky) throw new Error("Sanctions vendor timed out");
  const match = forced
    ? forced === "sanctions-match"
    : simulation.random({ label: "sanctions", min: 0, max: 1 }) < 0.1;
  if (match) throw new PaymentDeclined("Sanctions list match");
  return { result: "clear" };
}

/**
 * Writes matching debit and credit entries. One statement, so they are atomic.
 * Safe to repeat: posting a payment that's already posted changes nothing, so a
 * retry can't charge twice.
 *
 * `responseTimesOut` makes the write succeed but then throw, like a ledger
 * service whose reply never arrives: the caller can't tell it worked.
 */
export async function postLedger({
  paymentId,
  from,
  to,
  amountCents,
  simulation,
  responseTimesOut = false,
}: {
  paymentId: string;
  from: string;
  to: string;
  amountCents: number;
  simulation: Simulation;
  responseTimesOut?: boolean;
}) {
  await pause({ simulation, minMs: 500, maxMs: 1000 });
  await pool.query(
    `INSERT INTO ledger_entries (payment_id, account, direction, amount_cents)
     VALUES ($1, $2, 'debit', $4), ($1, $3, 'credit', $4)
     ON CONFLICT (payment_id, direction) DO NOTHING`,
    [paymentId, from, to, amountCents],
  );
  if (responseTimesOut) throw new Error("Ledger response timed out");
  return { posted: true };
}
