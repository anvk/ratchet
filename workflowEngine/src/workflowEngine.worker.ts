import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  Claim,
  Registry,
  WorkflowEngineSettings,
  WorkflowStore,
} from "./workflowEngine.types.ts";

/**
 * Runs one claimed step and records whether it succeeded or failed. Returns
 * the run's next step if the store handed it straight to this worker.
 */
async function executeStep({
  registry,
  store,
  workerId,
  claim,
  claimNext,
}: {
  registry: Registry;
  store: WorkflowStore;
  workerId: string;
  claim: Claim;
  claimNext: boolean;
}): Promise<Claim | null> {
  const step = registry.get(claim.workflow)?.steps.find((s) => s.name === claim.stepName);
  if (!step) {
    await store.failStep(
      claim,
      `This worker does not know step ${claim.workflow}/${claim.stepName}`,
    );
    return null;
  }

  let output: unknown;
  try {
    output = await step.run({
      runId: claim.runId,
      stepName: claim.stepName,
      attempt: claim.attempt,
      input: claim.input,
      outputs: claim.outputs,
      idempotencyKey: `${claim.runId}:${claim.stepName}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[${workerId}] ${claim.stepName} failed: ${message}`);
    await store.failStep(claim, message);
    return null;
  }
  console.log(`[${workerId}] ${claim.stepName} succeeded`);
  const { next } = await store.completeStep({ claim, output, claimNext });
  return next;
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
  const { pollMs, errorBackoffMs, claimOrder } = settings;
  const workflowNames = [...registry.keys()];

  /** Waits, but wakes up as soon as the worker is told to stop. */
  const wait = (ms: number) => sleep(ms, undefined, { signal: stopSignal }).catch(() => {});

  console.log(`[${workerId}] polling every ${pollMs}ms, claim order ${claimOrder}`);

  while (!stopSignal.aborted) {
    try {
      let claim = await store.claimStep({ workerId, workflowNames, order: claimOrder });
      if (!claim) {
        await wait(pollMs);
        continue;
      }
      // Sticky workers keep going on the same run, unless they've been told to stop.
      while (claim) {
        const claimNext = claimOrder === "sticky" && !stopSignal.aborted;
        claim = await executeStep({ registry, store, workerId, claim, claimNext });
      }
    } catch (err) {
      console.error(`[${workerId}] loop error:`, err instanceof Error ? err.message : err);
      await wait(errorBackoffMs);
    }
  }

  console.log(`[${workerId}] stopped`);
}
