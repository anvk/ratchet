import { NonRetryableError, type StepRunContext } from "@ratchet/engine";
import { describeWorkflow } from "../describeWorkflow.ts";
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

export interface PaymentInput {
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
  /**
   * How many attempts of the sanctions check never get an answer, so each is cut
   * off by the step's timeout.
   */
  vendorHangs?: number;
  /** Makes the first ledger write succeed but report a timeout, so it gets retried. */
  ledgerTimeout?: boolean;
  /**
   * The sender's account. Payments from the same account run one at a time, so
   * two of them can't both pass the balance check before either is posted.
   * Without it, a payment is in no group.
   */
  account?: string;
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
function simulationFor({ step, input }: { step: StepRunContext; input: PaymentInput }) {
  return createSimulation({
    key: `${step.runId}:${step.stepName}:${step.attempt}`,
    forceOutcome: input.forceOutcome,
    timeScale: input.timeScale,
    // If the step is no longer this worker's, stop waiting on the "vendor".
    signal: step.abortSignal,
  });
}

export default describeWorkflow<PaymentInput>({
  name: "payment",
  version: "1",
  title: "Process a payment",
  description:
    "Takes a fake payment through account checks, runs the risk and sanctions checks side by side, then posts it to the ledger.",
  concurrency: { key: (input) => (input.account ? `account:${input.account}` : null), limit: 1 },
  steps: {
    "receive-payment": {
      title: "Receive payment",
      description: "Accepts the payment request and fixes its amount and accounts.",
    },
    "validate-account": {
      title: "Validate account",
      description: "Checks that the sender has enough funds.",
    },
    "score-risk": {
      title: "Score risk",
      description: "Runs a Monte Carlo simulation and declines payments that score above 85.",
    },
    "screen-sanctions": {
      title: "Screen sanctions",
      description:
        "Checks both parties against a fake government sanctions list. The vendor sometimes times out, so it's retried.",
    },
    "post-ledger": {
      title: "Post to ledger",
      description: "Writes matching debit and credit entries.",
    },
  },
  async run(ctx) {
    const { input } = ctx;

    const payment = await ctx.step("receive-payment", (step) =>
      receivePayment({
        paymentId: ctx.runId,
        amountCents: input.amountCents,
        from: input.account,
        simulation: simulationFor({ step, input }),
      }),
    );

    await ctx.step("validate-account", (step) =>
      finalIfDeclined(
        validateAccount({
          amountCents: payment.amountCents,
          simulation: simulationFor({ step, input }),
        }),
      ),
    );

    // Neither check needs the other's answer, so they are asked for together
    // and run side by side. If either declines, the payment fails at once and
    // the other check is stopped.
    await Promise.all([
      ctx.step(
        "score-risk",
        (step) =>
          finalIfDeclined(
            scoreRisk({
              simulation: simulationFor({ step, input }),
              // Only the first attempt, so the retry on another worker succeeds.
              overloaded: input.overloadRisk === true && step.attempt === 1,
            }),
          ),
        // A risk check blocks its worker for 3 to 4.5 seconds, so no heartbeat
        // can run until it ends. 10 seconds is twice the slowest normal check,
        // and recovers a stuck one sooner than the engine's 30-second default.
        { leaseMs: 10_000 },
      ),
      ctx.step(
        "screen-sanctions",
        (step) =>
          finalIfDeclined(
            screenSanctions({
              simulation: simulationFor({ step, input }),
              timesOut: step.attempt <= (input.vendorTimeouts ?? 0),
              hangs: step.attempt <= (input.vendorHangs ?? 0),
            }),
          ),
        // A flaky vendor gets more tries, starting half a second apart. A normal
        // check answers within 4 seconds, so 6 seconds only cuts off a vendor
        // that has stopped answering.
        { maxAttempts: 4, backoffMs: 500, timeoutMs: 6_000 },
      ),
    ]);

    return ctx.step("post-ledger", (step) =>
      postLedger({
        ...payment,
        simulation: simulationFor({ step, input }),
        responseTimesOut: input.ledgerTimeout === true && step.attempt === 1,
      }),
    );
  },
});
