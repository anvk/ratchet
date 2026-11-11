import { defineWorkflow, NonRetryableError, type StepContext } from "@ratchet/engine";
import {
  createSimulation,
  PaymentDeclined,
  postLedger,
  receivePayment,
  scoreRisk,
  screenSanctions,
  validateAccount,
  type Outcome,
} from "./payment.service.ts";

interface PaymentInput {
  amountCents?: number;
  /** Force a result instead of leaving it to chance. */
  forceOutcome?: Outcome;
  /** Multiplies waits and simulation size. 0 runs instantly. */
  timeScale?: number;
  /**
   * Makes the risk check's first attempt so heavy that its worker can't send
   * heartbeats, so its lease expires and another worker redoes it.
   */
  overloadRisk?: boolean;
  /** How many attempts of the sanctions check time out before one gets through. */
  vendorTimeouts?: number;
  /** Makes the first ledger write succeed but report a timeout, so it gets retried. */
  ledgerTimeout?: boolean;
}

/**
 * Runs a payment operation, turning a decline into a NonRetryableError: the
 * engine retries timeouts, but asking again won't change a decision.
 */
async function finalIfDeclined<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (err) {
    if (err instanceof PaymentDeclined) throw new NonRetryableError(err.message);
    throw err;
  }
}

/** Builds the simulation for one attempt of one step. */
function simulationFor(ctx: StepContext<PaymentInput>) {
  return createSimulation({
    key: `${ctx.runId}:${ctx.stepName}:${ctx.attempt}`,
    forceOutcome: ctx.input.forceOutcome,
    timeScale: ctx.input.timeScale,
  });
}

export default defineWorkflow<PaymentInput>({
  name: "payment",
  title: "Process a payment",
  description:
    "Takes a fake payment through account, risk and sanctions checks, then posts it to the ledger.",
  presets: [
    { label: "Random payment", input: {} },
    { label: "Payment clears", input: { forceOutcome: "clear" } },
    { label: "Insufficient funds", input: { forceOutcome: "insufficient-funds" } },
    { label: "Declined by risk score", input: { forceOutcome: "risk-declined" } },
    { label: "Sanctions match", input: { forceOutcome: "sanctions-match" } },
    {
      label: "Risk check overloads its worker",
      input: { forceOutcome: "clear", overloadRisk: true },
    },
    { label: "Flaky sanctions vendor", input: { forceOutcome: "clear", vendorTimeouts: 2 } },
    // Times out on all 4 attempts screen-sanctions gets, so the run gives up.
    { label: "Sanctions vendor down", input: { forceOutcome: "clear", vendorTimeouts: 4 } },
    { label: "Ledger write times out", input: { forceOutcome: "clear", ledgerTimeout: true } },
  ],
  steps: [
    {
      name: "receive-payment",
      title: "Receive payment",
      description: "Accepts the payment request and fixes its amount and accounts.",
      run: (ctx) =>
        receivePayment({
          paymentId: ctx.runId,
          amountCents: ctx.input.amountCents,
          simulation: simulationFor(ctx),
        }),
    },
    {
      name: "validate-account",
      title: "Validate account",
      description: "Checks that the sender has enough funds.",
      run: (ctx) =>
        finalIfDeclined(
          validateAccount({
            amountCents: ctx.outputs["receive-payment"].amountCents,
            simulation: simulationFor(ctx),
          }),
        ),
    },
    {
      name: "score-risk",
      title: "Score risk",
      description: "Runs a Monte Carlo simulation and declines payments that score above 85.",
      // A risk check blocks its worker for 3 to 4.5 seconds, so no heartbeat can
      // run until it ends. 10 seconds is twice the slowest normal check, and
      // recovers a stuck one sooner than the engine's 30-second default.
      leaseMs: 10_000,
      run: (ctx) =>
        finalIfDeclined(
          scoreRisk({
            simulation: simulationFor(ctx),
            // Only the first attempt, so the retry on another worker succeeds.
            overloaded: ctx.input.overloadRisk === true && ctx.attempt === 1,
          }),
        ),
    },
    {
      name: "screen-sanctions",
      title: "Screen sanctions",
      description:
        "Checks both parties against a fake government sanctions list. The vendor sometimes times out, so it's retried.",
      // A flaky vendor gets more tries, starting half a second apart.
      maxAttempts: 4,
      backoffMs: 500,
      run: (ctx) =>
        finalIfDeclined(
          screenSanctions({
            simulation: simulationFor(ctx),
            timesOut: ctx.attempt <= (ctx.input.vendorTimeouts ?? 0),
          }),
        ),
    },
    {
      name: "post-ledger",
      title: "Post to ledger",
      description: "Writes matching debit and credit entries.",
      run: (ctx) =>
        postLedger({
          ...ctx.outputs["receive-payment"],
          simulation: simulationFor(ctx),
          responseTimesOut: ctx.input.ledgerTimeout === true && ctx.attempt === 1,
        }),
    },
  ],
});
