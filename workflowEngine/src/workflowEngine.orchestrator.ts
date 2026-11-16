import { setTimeout as sleep } from "node:timers/promises";
import type {
  ScheduleToFire,
  WorkflowEngineSettings,
  WorkflowStore,
} from "./workflowEngine.types.ts";
import { stepDefaults } from "./workflowEngine.utils.ts";

/**
 * Looks after runs as a whole, rather than single steps, until stopSignal
 * fires. Every sweepIntervalMs it does two jobs: the lease sweep, which makes
 * steps whose worker stopped sending heartbeats ready again, and starting a run
 * for each of `schedules` that is due. Either failing doesn't skip the other.
 * Any number of orchestrators can run at once.
 */
export async function runOrchestrator({
  store,
  settings,
  stopSignal,
  schedules,
}: {
  store: WorkflowStore;
  settings: WorkflowEngineSettings;
  stopSignal: AbortSignal;
  schedules: ScheduleToFire[];
}) {
  const { sweepIntervalMs } = settings;

  /** Waits, but wakes up as soon as the orchestrator is told to stop. */
  const wait = (ms: number) => sleep(ms, undefined, { signal: stopSignal }).catch(() => {});

  console.log(
    `[orchestrator] sweeping expired leases every ${sweepIntervalMs}ms` +
      (schedules.length > 0 ? `, watching ${schedules.length} schedule(s)` : ""),
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
      const started = await store.fireDueSchedules({ schedules });
      if (started > 0) console.log(`[orchestrator] started ${started} scheduled run(s)`);
    } catch (err) {
      console.error("[orchestrator] schedules failed:", err instanceof Error ? err.message : err);
    }
    await wait(sweepIntervalMs);
  }

  console.log("[orchestrator] stopped");
}
