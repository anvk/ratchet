import { once } from "node:events";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { NonRetryableError } from "./workflowEngine.errors.ts";
import { locate, type StepRunContext } from "./workflowEngine.replay.ts";
import type {
  AdvanceRun,
  Claim,
  MessageBroker,
  Registry,
  StepDefaults,
  WorkflowEngineSettings,
  WorkflowStore,
} from "./workflowEngine.types.ts";
import { stepDefaults } from "./workflowEngine.utils.ts";

/**
 * Renews a claim's lease every third of it, until stopped. If a renewal finds
 * that this worker no longer owns the step, `signal` fires and renewals stop.
 * `beat` renews at once, for when a message says the step may have been taken
 * away: the store's answer decides, never the message.
 */
function startHeartbeat({
  store,
  workerId,
  claim,
}: {
  store: WorkflowStore;
  workerId: string;
  claim: Claim;
}) {
  const leaseLost = new AbortController();
  const beat = () => {
    store
      .extendLease(claim)
      .then((owned) => {
        if (owned || leaseLost.signal.aborted) return;
        console.log(
          `[${workerId}] ${claim.stepName} is no longer this worker's (attempt ${claim.attempt})`,
        );
        clearInterval(timer);
        leaseLost.abort();
      })
      // A failed renewal isn't fatal: the next one may work. If they all fail,
      // the lease expires and the orchestrator gives the step to another worker.
      .catch((err) => console.error(`[${workerId}] heartbeat failed:`, err));
  };
  const timer = setInterval(beat, claim.leaseMs / 3);
  return { signal: leaseLost.signal, stop: () => clearInterval(timer), beat };
}

/** The step a worker is running, for a `run_cancelled` message to find. */
interface RunningStep {
  runId: string;
  /** Checks with the store, now, whether this worker still owns the step. */
  checkOwnership: () => void;
}

/**
 * Starts the clock on one attempt. `signal` fires once `timeoutMs` has passed,
 * unless stopped first.
 */
function startTimeout(timeoutMs: number) {
  const timedOut = new AbortController();
  const timer = setTimeout(() => timedOut.abort(), timeoutMs);
  return { signal: timedOut.signal, stop: () => clearTimeout(timer) };
}

/**
 * Runs one claimed step, sending heartbeats while it runs, and records whether
 * it succeeded or failed. The step's code is found by running the workflow up
 * to where it asks for this step, with the results the run had saved when the
 * step was claimed. A NonRetryableError fails the step for good; any other
 * error is retried while it has attempts left. An attempt that runs past
 * `timeoutMs` (the step's own, or the engine's) is no longer waited for: its
 * signal fires and the attempt fails like a thrown error. Either way the run is
 * advanced as the result is recorded. Returns the run's next step if the store
 * handed it straight to this worker.
 */
async function executeStep({
  registry,
  store,
  workerId,
  claim,
  claimNext,
  defaults,
  defaultTimeoutMs,
  running,
  advance,
}: {
  registry: Registry;
  store: WorkflowStore;
  workerId: string;
  claim: Claim;
  claimNext: boolean;
  defaults: StepDefaults;
  /** The engine's timeoutMs, for a step that doesn't set its own. */
  defaultTimeoutMs: number;
  /** Set to this step while its function runs, and cleared after. */
  running: { step: RunningStep | null };
  advance: AdvanceRun;
}): Promise<Claim | null> {
  // A worker only claims runs of workflows it has, at the version it has.
  const definition = registry.get(claim.workflow)!;
  const step = await locate({
    request: {
      run: definition.run,
      runId: claim.runId,
      input: claim.input,
      steps: claim.saved,
    },
    step: claim.stepName,
  });
  if (!step) {
    // Retrying can't help: this code doesn't ask for the step on the path the run has taken.
    await store.failStep({
      claim,
      error: `The code of ${claim.workflow} never asked for step ${claim.stepName}`,
      final: "unknown_step",
      defaults,
      advance,
    });
    return null;
  }

  const heartbeat = startHeartbeat({ store, workerId, claim });
  const timeoutMs = step.options.timeoutMs ?? defaultTimeoutMs;
  const timeout = startTimeout(timeoutMs);
  running.step = { runId: claim.runId, checkOwnership: heartbeat.beat };
  /** Called once the step's function is no longer waited for. */
  const stopWatching = () => {
    heartbeat.stop();
    timeout.stop();
    running.step = null;
  };
  let output: unknown;
  try {
    // Wrapped, so a step that returns a plain value instead of a promise still works.
    const stepContext: StepRunContext = {
      runId: claim.runId,
      stepName: claim.stepName,
      attempt: claim.attempt,
      idempotencyKey: `${claim.runId}:${claim.stepName}`,
      abortSignal: AbortSignal.any([heartbeat.signal, timeout.signal]),
    };
    // Through a promise, so a step that throws before its first await, or
    // returns a plain value, is treated like any other.
    const attempt = Promise.resolve().then(() => step.fn(stepContext));
    // A timed-out attempt is no longer waited for, so nothing else would catch
    // what it throws later.
    attempt.catch(() => {});
    const expired = new Promise<never>((_, reject) => {
      timeout.signal.addEventListener(
        "abort",
        () => reject(new Error(`Timed out after ${timeoutMs}ms`)),
        { once: true },
      );
    });
    output = await Promise.race([attempt, expired]);
  } catch (err) {
    stopWatching();
    const message = err instanceof Error ? err.message : String(err);
    const { recorded, retryInMs, failureReason } = await store.failStep({
      claim,
      error: message,
      final: err instanceof NonRetryableError ? "non_retryable" : null,
      defaults,
      advance,
    });
    if (!recorded) logRejected({ workerId, claim });
    else if (failureReason) {
      console.log(`[${workerId}] ${claim.stepName} failed (${failureReason}): ${message}`);
    } else {
      console.log(
        `[${workerId}] ${claim.stepName} attempt ${claim.attempt} failed: ${message} (retrying in ${retryInMs}ms)`,
      );
    }
    return null;
  }
  stopWatching();

  const { completed, next } = await store.completeStep({
    claim,
    output,
    claimNext,
    defaults,
    advance,
  });
  if (completed) console.log(`[${workerId}] ${claim.stepName} succeeded`);
  else logRejected({ workerId, claim });
  return next;
}

/** Logs a result the store refused because another worker took the step over. */
function logRejected({ workerId, claim }: { workerId: string; claim: Claim }) {
  console.log(
    `[${workerId}] ${claim.stepName} result rejected: attempt ${claim.attempt} no longer owns the step`,
  );
}

/**
 * Does a worker's two jobs, one at a time, until stopSignal fires, finishing
 * the step it is on: advancing runs that are marked for it, and claiming and
 * running steps. When there is neither it waits for a `step_ready`
 * message, however long that takes: it has no timer of its own, so the message
 * broker decides how often it looks. A `run_cancelled` message for the run it
 * is working on makes it ask the store at once whether it still owns the step.
 */
export async function runWorker({
  registry,
  store,
  messageBroker,
  settings,
  advance,
  stopSignal,
  workerId = `${hostname()}-${process.pid}`,
}: {
  registry: Registry;
  store: WorkflowStore;
  messageBroker: MessageBroker;
  settings: WorkflowEngineSettings;
  /** Runs a run's workflow code. See AdvanceRun. */
  advance: AdvanceRun;
  stopSignal: AbortSignal;
  workerId?: string;
}) {
  const { errorBackoffMs, claimOrder } = settings;
  const defaults = stepDefaults(settings);
  const workflows = [...registry.values()];

  const running: { step: RunningStep | null } = { step: null };
  // Fired by a step_ready message. Replaced before each claim, so a message
  // that arrives while a claim is under way still ends the wait after it.
  let wake = new AbortController();

  /** Waits, but wakes up as soon as the worker is told to stop. */
  const wait = (ms: number) => sleep(ms, undefined, { signal: stopSignal }).catch(() => {});
  /** Waits for a step_ready message, or to be told to stop. Returns at once if one came during the last claim. */
  const waitForWork = async () => {
    const woken = AbortSignal.any([stopSignal, wake.signal]);
    if (!woken.aborted) await once(woken, "abort");
  };

  await messageBroker.subscribe((message) => {
    if (message.type === "step_ready") wake.abort();
    else if (running.step?.runId === message.runId) running.step.checkOwnership();
  });

  console.log(`[${workerId}] pid ${process.pid}, claim order ${claimOrder}`);

  while (!stopSignal.aborted) {
    try {
      wake = new AbortController();
      // Advancing comes first: it is quick, and it is what makes steps claimable.
      if (await store.advanceRun({ workflows, advance })) continue;
      let claim = await store.claimStep({
        workerId,
        workflows,
        order: claimOrder,
        defaults,
      });
      if (!claim) {
        await waitForWork();
        continue;
      }
      // Sticky workers keep going on the same run, unless they've been told to stop.
      while (claim) {
        const claimNext = claimOrder === "sticky" && !stopSignal.aborted;
        claim = await executeStep({
          registry,
          store,
          workerId,
          claim,
          claimNext,
          defaults,
          defaultTimeoutMs: settings.timeoutMs,
          running,
          advance,
        });
      }
    } catch (err) {
      console.error(`[${workerId}] loop error:`, err instanceof Error ? err.message : err);
      await wait(errorBackoffMs);
    }
  }

  console.log(`[${workerId}] stopped`);
}
