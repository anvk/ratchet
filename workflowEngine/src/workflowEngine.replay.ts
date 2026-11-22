import { setImmediate as nextTurn } from "node:timers/promises";
import { NonRetryableError, StepFailedError } from "./workflowEngine.errors.ts";
import type {
  AskedStep,
  Decision,
  ReplayRequest,
  StepFunction,
  StepOptions,
  WorkflowContext,
} from "./workflowEngine.types.ts";

export type {
  AskedStep,
  Decision,
  ReplayRequest,
  SavedStep,
  StepFunction,
  StepOptions,
  StepRunContext,
  WorkflowContext,
  WorkflowFunction,
} from "./workflowEngine.types.ts";

// Runs a workflow written as a function against the results its run has
// already saved. Nothing here touches a store or a worker: it takes a plain
// description of what is saved and returns a plain description of what the
// function did.
//
// A workflow function is run again from the top each time. A step whose result
// is saved hands that result back at once, without running, so the function
// moves straight to the first thing it doesn't have yet.

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
  const invalid: string[] = [];

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
      invalid.push(...problemsWith({ name, options }));
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

  return { asked, usedTwice, invalid, outcome };
}

/** What is wrong with a step's name or options, as messages. Empty if nothing is. */
function problemsWith({ name, options }: { name: string; options: StepOptions }): string[] {
  const problems: string[] = [];
  if (typeof name !== "string" || name.trim() === "") problems.push("A step needs a name");
  const wholeAndAtLeast = (value: number | undefined, least: number) =>
    value === undefined || (Number.isInteger(value) && value >= least);
  for (const key of ["leaseMs", "maxAttempts", "timeoutMs"] as const) {
    if (!wholeAndAtLeast(options[key], 1)) {
      problems.push(`Step ${name} needs a whole, positive ${key}`);
    }
  }
  if (!wholeAndAtLeast(options.backoffMs, 0)) {
    problems.push(`Step ${name} needs a whole backoffMs of 0 or more`);
  }
  return problems;
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
 * A step name used twice, or a step given options that make no sense, is the
 * function's own mistake, and fails the run with `workflow_error`.
 */
export async function advance<Input>(request: ReplayRequest<Input>): Promise<Decision> {
  const { asked, usedTwice, invalid, outcome } = await replay({ request });
  const { steps } = request;

  if (usedTwice.size > 0) {
    return {
      kind: "failed",
      reason: "workflow_error",
      error: `A step name was used more than once: ${[...usedTwice].join(", ")}`,
    };
  }
  if (invalid.length > 0) {
    return { kind: "failed", reason: "workflow_error", error: invalid.join("; ") };
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
  const order = [...asked.keys()];
  const requested: AskedStep[] = [];
  for (const name of unfinished.filter((unsaved) => !Object.hasOwn(steps, unsaved))) {
    requested.push({
      name,
      options: asked.get(name)!,
      after: await straightAfter({
        request,
        step: name,
        askedBefore: order.slice(0, order.indexOf(name)),
      }),
    });
  }
  return { kind: "parked", requested, waitingOn: unfinished };
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

/**
 * The steps a newly asked-for step comes straight after (see AskedStep.after).
 *
 * The function is run again once for each step that might count, with that
 * step's result taken away: if it then no longer asks for the new step, the new
 * step needed it. Candidates are tried latest first, and once one counts,
 * everything it came after is known to count too, through it, and needn't be
 * tried. So steps in a row cost one extra run each, however long the row.
 */
async function straightAfter<Input>({
  request,
  step,
  askedBefore,
}: {
  request: ReplayRequest<Input>;
  step: string;
  /** Every step the function asked for before this one, in order. */
  askedBefore: string[];
}): Promise<string[]> {
  const { steps, after = {} } = request;
  const candidates = askedBefore
    .filter((name) => Object.hasOwn(steps, name) && steps[name].status !== "open")
    .reverse();

  // Each step that counts, with what the function still asked for without it.
  const needed = new Map<string, Set<string>>();
  const throughAnother = new Set<string>();
  const markBehind = (name: string) => {
    for (const earlier of Object.hasOwn(after, name) ? after[name] : []) {
      if (throughAnother.has(earlier)) continue;
      throughAnother.add(earlier);
      markBehind(earlier);
    }
  };
  for (const candidate of candidates) {
    if (throughAnother.has(candidate)) continue;
    const without = await replay({
      request: { ...request, steps: { ...steps, [candidate]: { status: "open" } } },
    });
    if (without.asked.has(step)) continue;
    needed.set(candidate, new Set(without.asked.keys()));
    markBehind(candidate);
  }
  // Where `after` didn't say so already: a step that another needed step itself
  // needs is reached through that one, so it isn't straight before this step.
  const names = [...needed.keys()];
  return names
    .filter((name) => !names.some((other) => other !== name && !needed.get(name)!.has(other)))
    .reverse();
}
