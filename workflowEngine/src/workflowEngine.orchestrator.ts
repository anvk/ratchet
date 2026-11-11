import { setTimeout as sleep } from "node:timers/promises";
import type { WorkflowEngineSettings, WorkflowStore } from "./workflowEngine.types.ts";
import { stepDefaults } from "./workflowEngine.utils.ts";

/**
 * Looks after runs as a whole, rather than single steps, until stopSignal
 * fires. Its one job so far is the lease sweep: every sweepIntervalMs, steps
 * whose worker stopped sending heartbeats become ready again. Any number of
 * orchestrators can run at once.
 */
export async function runOrchestrator({
  store,
  settings,
  stopSignal,
}: {
  store: WorkflowStore;
  settings: WorkflowEngineSettings;
  stopSignal: AbortSignal;
}) {
  const { sweepIntervalMs } = settings;

  /** Waits, but wakes up as soon as the orchestrator is told to stop. */
  const wait = (ms: number) => sleep(ms, undefined, { signal: stopSignal }).catch(() => {});

  console.log(`[orchestrator] sweeping expired leases every ${sweepIntervalMs}ms`);

  while (!stopSignal.aborted) {
    try {
      const swept = await store.sweepExpiredLeases({ defaults: stepDefaults(settings) });
      if (swept > 0)
        console.log(`[orchestrator] made ${swept} step(s) with expired leases ready again`);
    } catch (err) {
      console.error("[orchestrator] sweep failed:", err instanceof Error ? err.message : err);
    }
    await wait(sweepIntervalMs);
  }

  console.log("[orchestrator] stopped");
}
