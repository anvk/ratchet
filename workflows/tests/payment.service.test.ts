// Runs against the local database from .env, which has the ledger table.
// Each test uses its own payment id and removes its rows afterwards.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import pg from "pg";
import {
  createSimulation,
  PaymentDeclined,
  postLedger,
  screenSanctions,
  validateAccount,
} from "../payment/payment.service.ts";

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const paymentIds: string[] = [];
after(async () => {
  await db.query("DELETE FROM ledger_entries WHERE payment_id = ANY($1)", [paymentIds]);
  await db.end();
});

/** A fresh payment, remembered for clean-up. */
function newPayment() {
  const paymentId = randomUUID();
  paymentIds.push(paymentId);
  return { paymentId, from: "acct_sender", to: "acct_merchant", amountCents: 1234 };
}

/** A simulation with no waits, optionally forcing an outcome. */
const instant = (forceOutcome?: "clear" | "insufficient-funds" | "sanctions-match") =>
  createSimulation({ key: randomUUID(), forceOutcome, timeScale: 0 });

/** The ledger rows for a payment, as "direction amount". */
const ledgerRows = async (paymentId: string) =>
  (
    await db.query<{ direction: string; amount_cents: string }>(
      "SELECT direction, amount_cents FROM ledger_entries WHERE payment_id = $1 ORDER BY id",
      [paymentId],
    )
  ).rows.map((r) => `${r.direction} ${r.amount_cents}`);

test("posting a payment writes one debit and one credit", async () => {
  const payment = newPayment();
  await postLedger({ ...payment, simulation: instant() });
  assert.deepEqual(await ledgerRows(payment.paymentId), ["debit 1234", "credit 1234"]);
});

test("posting the same payment again doesn't charge twice", async () => {
  const payment = newPayment();
  await postLedger({ ...payment, simulation: instant() });
  await postLedger({ ...payment, simulation: instant() });
  assert.deepEqual(await ledgerRows(payment.paymentId), ["debit 1234", "credit 1234"]);
});

test("a retry after a lost reply doesn't charge twice", async () => {
  const payment = newPayment();
  // The first post is written, but its reply "times out", so a retry follows.
  await assert.rejects(
    postLedger({ ...payment, simulation: instant(), responseTimesOut: true }),
    /Ledger response timed out/,
  );
  await postLedger({ ...payment, simulation: instant() });
  assert.deepEqual(await ledgerRows(payment.paymentId), ["debit 1234", "credit 1234"]);
});

test("declines are PaymentDeclined, so the workflow doesn't retry them", async () => {
  await assert.rejects(
    validateAccount({ amountCents: 100, simulation: instant("insufficient-funds") }),
    PaymentDeclined,
  );
  await assert.rejects(
    screenSanctions({ simulation: instant("sanctions-match") }),
    PaymentDeclined,
  );
});

test("a vendor timeout is a plain error, so the workflow retries it", async () => {
  const error = await screenSanctions({ simulation: instant("clear"), timesOut: true }).catch(
    (err: unknown) => err,
  );
  assert.ok(error instanceof Error);
  assert.ok(!(error instanceof PaymentDeclined));
  assert.equal(error.message, "Sanctions vendor timed out");
});
