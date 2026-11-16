import { setTimeout as sleep } from "node:timers/promises";
import type {
  ScheduledRun,
  WorkflowDefinition,
  WorkflowEngineSettings,
  WorkflowStore,
} from "./workflowEngine.types.ts";
import { stepDefaults } from "./workflowEngine.utils.ts";

/**
 * Looks after runs as a whole, rather than single steps, until stopSignal
 * fires. Every sweepIntervalMs it does two jobs: the lease sweep, which makes
 * steps whose worker stopped sending heartbeats ready again, and starting a run
 * for each due, unpaused schedule of `workflows`. Either failing doesn't skip
 * the other.
 * Any number of orchestrators can run at once.
 */
export async function runOrchestrator({
  store,
  settings,
  stopSignal,
  workflows,
  scheduledRunFor,
}: {
  store: WorkflowStore;
  settings: WorkflowEngineSettings;
  stopSignal: AbortSignal;
  workflows: WorkflowDefinition[];
  /** Works out a due schedule's run. See WorkflowStore.fireDueSchedules. */
  scheduledRunFor: (schedule: { workflow: string; name: string; input: unknown }) => ScheduledRun;
}) {
  const { sweepIntervalMs } = settings;

  /** Waits, but wakes up as soon as the orchestrator is told to stop. */
  const wait = (ms: number) => sleep(ms, undefined, { signal: stopSignal }).catch(() => {});

  console.log(
    `[orchestrator] sweeping expired leases and firing due schedules every ${sweepIntervalMs}ms`,
  );

  while (!stopSignal.aborted) {
    try {
      const swept = await store.sweepExpiredLeases({ defaults: stepDefaults(settings) });
      if (swept > 0)
        console.log(`[orchestrator] made ${swept} step(s) with expired leases ready again`);
    } catch (err) {
      console.error("[orchestrator] sweep failed:", err instanceof Error ? err.message : err);
    }
    try {
      const started = await store.fireDueSchedules({ workflows, scheduledRunFor });
      if (started > 0) console.log(`[orchestrator] started ${started} scheduled run(s)`);
    } catch (err) {
      console.error("[orchestrator] schedules failed:", err instanceof Error ? err.message : err);
    }
    await wait(sweepIntervalMs);
  }

  console.log("[orchestrator] stopped");
}
