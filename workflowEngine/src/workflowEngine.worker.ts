import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  Claim,
  Registry,
  WorkflowEngineSettings,
  WorkflowStore,
} from "./workflowEngine.types.ts";

/**
 * Renews a claim's lease every third of it, until stopped. If a renewal finds
 * that this worker no longer owns the step, `signal` fires and renewals stop.
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
  const lost = new AbortController();
  const timer = setInterval(() => {
    store
      .extendLease(claim)
      .then((owned) => {
        if (owned || lost.signal.aborted) return;
        console.log(`[${workerId}] ${claim.stepName} lost its lease (attempt ${claim.attempt})`);
        clearInterval(timer);
        lost.abort();
      })
      // A failed renewal isn't fatal: the next one may work. If they all fail,
      // the lease expires and the orchestrator gives the step to another worker.
      .catch((err) => console.error(`[${workerId}] heartbeat failed:`, err));
  }, claim.leaseMs / 3);
  return { signal: lost.signal, stop: () => clearInterval(timer) };
}

/**
 * Runs one claimed step, sending heartbeats while it runs, and records whether
 * it succeeded or failed. Returns the run's next step if the store handed it
 * straight to this worker.
 */
async function executeStep({
  registry,
  store,
  workerId,
  claim,
  claimNext,
  defaultLeaseMs,
}: {
  registry: Registry;
  store: WorkflowStore;
  workerId: string;
  claim: Claim;
  claimNext: boolean;
  defaultLeaseMs: number;
}): Promise<Claim | null> {
  const step = registry.get(claim.workflow)?.steps.find((s) => s.name === claim.stepName);
  if (!step) {
    await store.failStep(
      claim,
      `This worker does not know step ${claim.workflow}/${claim.stepName}`,
    );
    return null;
  }

  const heartbeat = startHeartbeat({ store, workerId, claim });
  let output: unknown;
  try {
    output = await step.run({
      runId: claim.runId,
      stepName: claim.stepName,
      attempt: claim.attempt,
      input: claim.input,
      outputs: claim.outputs,
      idempotencyKey: `${claim.runId}:${claim.stepName}`,
      signal: heartbeat.signal,
    });
  } catch (err) {
    heartbeat.stop();
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[${workerId}] ${claim.stepName} failed: ${message}`);
    if (!(await store.failStep(claim, message))) logRejected({ workerId, claim });
    return null;
  }
  heartbeat.stop();

  const { completed, next } = await store.completeStep({
    claim,
    output,
    claimNext,
    defaultLeaseMs,
  });
  if (completed) console.log(`[${workerId}] ${claim.stepName} succeeded`);
  else logRejected({ workerId, claim });
  return next;
}

/** Logs a result the store refused because another worker took the step over. */
function logRejected({ workerId, claim }: { workerId: string; claim: Claim }) {
  console.log(
    `[${workerId}] ${claim.stepName} result rejected: attempt ${claim.attempt} lost its lease`,
  );
}

/** Claims and runs steps one at a time until stopSignal fires, finishing the current step. */
export async function runWorker({
  registry,
  store,
  settings,
  stopSignal,
  workerId = `${hostname()}-${process.pid}`,
}: {
  registry: Registry;
  store: WorkflowStore;
  settings: WorkflowEngineSettings;
  stopSignal: AbortSignal;
  workerId?: string;
}) {
  const { pollMs, errorBackoffMs, claimOrder, leaseMs } = settings;
  const workflowNames = [...registry.keys()];

  /** Waits, but wakes up as soon as the worker is told to stop. */
  const wait = (ms: number) => sleep(ms, undefined, { signal: stopSignal }).catch(() => {});

  console.log(
    `[${workerId}] pid ${process.pid}, polling every ${pollMs}ms, claim order ${claimOrder}`,
  );

  while (!stopSignal.aborted) {
    try {
      let claim = await store.claimStep({
        workerId,
        workflowNames,
        order: claimOrder,
        defaultLeaseMs: leaseMs,
      });
      if (!claim) {
        await wait(pollMs);
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
          defaultLeaseMs: leaseMs,
        });
      }
    } catch (err) {
      console.error(`[${workerId}] loop error:`, err instanceof Error ? err.message : err);
      await wait(errorBackoffMs);
    }
  }

  console.log(`[${workerId}] stopped`);
}
