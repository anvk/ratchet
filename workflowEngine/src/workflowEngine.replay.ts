import { setImmediate as nextTurn } from "node:timers/promises";
import type { FailureReason } from "./workflowEngine.constants.ts";
import { NonRetryableError, StepFailedError } from "./workflowEngine.errors.ts";

// Runs a workflow written as a function against the results its run has
// already saved. Nothing here touches a store or a worker: it takes a plain
// description of what is saved and returns a plain description of what the
// function did.
//
// A workflow function is run again from the top each time. A step whose result
// is saved hands that result back at once, without running, so the function
// moves straight to the first thing it doesn't have yet.

/** The settings a step may be given where the function asks for it. */
export interface StepOptions {
  /** How long a worker may go without a heartbeat before the step is given to another worker. */
  leaseMs?: number;
  /** How many times the step may run, counting the first. */
  maxAttempts?: number;
  /** The wait before the first retry, doubling for each one after it. */
  backoffMs?: number;
  /** How long one attempt may run. */
  timeoutMs?: number;
}

/** What a step's function receives when it runs. */
export interface StepRunContext {
  runId: string;
  stepName: string;
  /** Starts at 1. */
  attempt: number;
  /** The same on every attempt of this step. Pass it to anything with side effects. */
  idempotencyKey: string;
  /** Fires when the result won't be used: the step was taken away, or it ran past its time limit. */
  abortSignal: AbortSignal;
}

/** The code of one step. */
export type StepFunction<Output = unknown> = (step: StepRunContext) => Promise<Output> | Output;

/** What a workflow function receives. */
export interface WorkflowContext<Input = unknown> {
  runId: string;
  /** The input the run was started with. */
  input: Input;
  /**
   * Asks for a step. If the run has already saved this step's output, that
   * output comes back and `fn` is not called. If the step failed for good, a
   * StepFailedError is thrown here, which the function may catch. Otherwise
   * the promise doesn't settle in this replay: the function waits here until
   * it is run again with the step's result.
   *
   * A name may be used once in a run. Steps asked for without waiting in
   * between, as in `Promise.all`, are all asked for together.
   */
  step<Output>(name: string, fn: StepFunction<Output>, options?: StepOptions): Promise<Output>;
}

/**
 * A workflow as code. It must take the same path every time it is run with the
 * same saved results, so it may only wait on `ctx`, and anything that can
 * differ between two runs (the clock, random numbers, anything outside the
 * process) belongs inside a step.
 */
export type WorkflowFunction<Input = unknown, Output = unknown> = (
  ctx: WorkflowContext<Input>,
) => Promise<Output> | Output;

/**
 * What a run has saved about one step: its output, why it failed for good, or
 * `open` for a step the function asked for that hasn't finished.
 */
export type SavedStep =
  | { status: "succeeded"; output: unknown }
  | { status: "failed"; reason: FailureReason; error: string }
  | { status: "open" };

/** Why a replay ended a run in failure: a step's own reason, or one of the two a function can cause by itself. */
export type ReplayFailureReason =
  | FailureReason
  /** The function didn't take the path the saved steps say it took before. */
  | "nondeterministic"
  /** The function threw an error of its own. */
  | "workflow_error";

/** A step a function asked for. */
export interface AskedStep {
  name: string;
  options: StepOptions;
}

/**
 * What a workflow function did when run against what is saved.
 *
 * - `completed`: it returned.
 * - `failed`: it threw, or it broke one of the rules that replaying depends on.
 * - `parked`: it is waiting for steps that haven't finished. `requested` are
 *   the ones nothing is saved about yet, in the order it asked; `waitingOn` are
 *   all the unfinished steps it asked for, those included.
 */
export type Decision =
  | { kind: "completed"; output: unknown }
  | { kind: "failed"; reason: ReplayFailureReason; error: string; step?: string }
  | { kind: "parked"; requested: AskedStep[]; waitingOn: string[] };

/** What a replay needs: the function, and the run it is being replayed for. */
export interface ReplayRequest<Input = unknown> {
  run: WorkflowFunction<Input>;
  runId: string;
  input: Input;
  /** Everything the run has saved, by step name. */
  steps: Record<string, SavedStep>;
}

/** A promise that never settles, for a step this replay has no result for. */
const never = <T>() => new Promise<T>(() => {});

/**
 * Runs the function as far as it goes on what is saved. Returns every step it
 * asked for, any name it used twice, and how it ended, if it did. `onAsk` is
 * called as each step is asked for, with its code.
 */
async function replay<Input>({
  request,
  onAsk,
}: {
  request: ReplayRequest<Input>;
  onAsk?: (asked: { name: string; fn: StepFunction; options: StepOptions }) => void;
}) {
  const { run, runId, input, steps } = request;
  const asked = new Map<string, StepOptions>();
  const usedTwice = new Set<string>();

  const ctx: WorkflowContext<Input> = {
    runId,
    input,
    step<Output>(name: string, fn: StepFunction<Output>, options: StepOptions = {}) {
      if (asked.has(name)) {
        // Reported once the function has gone as far as it can, whatever it
        // does with this promise, so catching can't hide it.
        usedTwice.add(name);
        return never<Output>();
      }
      asked.set(name, options);
      onAsk?.({ name, fn, options });

      // Own-property check: a step may be named like something every object has.
      const saved = Object.hasOwn(steps, name) ? steps[name] : undefined;
      if (saved?.status === "succeeded") return Promise.resolve(saved.output as Output);
      if (saved?.status === "failed") {
        const failed = Promise.reject<Output>(
          new StepFailedError({ step: name, reason: saved.reason, message: saved.error }),
        );
        // The function may ask for a step and only wait for it later, or never.
        // Without this, Node would treat the rejection as unhandled meanwhile.
        failed.catch(() => {});
        return failed;
      }
      return never<Output>();
    },
  };

  let outcome: { ok: true; output: unknown } | { ok: false; error: unknown } | undefined;
  // Called through a promise, so a function that throws before its first
  // await, or isn't async at all, is treated like any other.
  void Promise.resolve()
    .then(() => run(ctx))
    .then(
      (output) => (outcome = { ok: true, output }),
      (error: unknown) => (outcome = { ok: false, error }),
    );

  // Saved results are promises that have already settled, so the function
  // moves through them in microtasks, all of which run before the next turn of
  // the event loop. After one turn it has either finished or is waiting on
  // something that isn't saved.
  await nextTurn();

  return { asked, usedTwice, outcome };
}

/**
 * Runs a workflow function against what its run has saved and says what it
 * did: finished, failed, or which steps it is waiting for. Runs no step.
 *
 * It also checks the function against the two rules replaying depends on, and
 * fails the run with `nondeterministic` when one is broken:
 *
 * - Every step the run has saved must be asked for again. One that isn't means
 *   the function took a different path this time: its code changed under the
 *   run, or it decided on something that isn't saved.
 * - The function may only wait on `ctx`. One that is waiting while everything
 *   it asked for is saved is waiting on something a replay can't see.
 *
 * A step name used twice is the function's own mistake, and fails the run with
 * `workflow_error`.
 */
export async function advance<Input>(request: ReplayRequest<Input>): Promise<Decision> {
  const { asked, usedTwice, outcome } = await replay({ request });
  const { steps } = request;

  if (usedTwice.size > 0) {
    return {
      kind: "failed",
      reason: "workflow_error",
      error: `A step name was used more than once: ${[...usedTwice].join(", ")}`,
    };
  }

  const notAskedAgain = Object.keys(steps).filter((name) => !asked.has(name));
  if (notAskedAgain.length > 0) {
    return {
      kind: "failed",
      reason: "nondeterministic",
      error: `The workflow didn't ask again for steps it asked for before: ${notAskedAgain.join(", ")}`,
    };
  }

  if (outcome?.ok) return { kind: "completed", output: outcome.output };

  if (outcome) {
    const { error } = outcome;
    // A step's failure that the function let through fails the run for the step's reason.
    if (error instanceof StepFailedError) {
      return { kind: "failed", reason: error.reason, error: error.message, step: error.step };
    }
    return {
      kind: "failed",
      reason: error instanceof NonRetryableError ? "non_retryable" : "workflow_error",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const unfinished = [...asked.keys()].filter(
    (name) => !Object.hasOwn(steps, name) || steps[name].status === "open",
  );
  if (unfinished.length === 0) {
    return {
      kind: "failed",
      reason: "nondeterministic",
      error: "The workflow is waiting on something that isn't a step",
    };
  }
  return {
    kind: "parked",
    requested: unfinished
      .filter((name) => !Object.hasOwn(steps, name))
      .map((name) => ({ name, options: asked.get(name)! })),
    waitingOn: unfinished,
  };
}

/**
 * Finds the code of one step, by running the workflow function against what
 * is saved until it asks for that step. Returns undefined if it never does,
 * which means this code has no such step on the path the run has taken.
 * Nothing is run and nothing is checked: that is `advance`'s job.
 */
export async function locate<Input>({
  request,
  step,
}: {
  request: ReplayRequest<Input>;
  /** The name of the step to find. */
  step: string;
}): Promise<{ fn: StepFunction; options: StepOptions } | undefined> {
  let found: { fn: StepFunction; options: StepOptions } | undefined;
  await replay({
    request,
    onAsk: ({ name, fn, options }) => {
      if (name === step) found ??= { fn, options };
    },
  });
  return found;
}
