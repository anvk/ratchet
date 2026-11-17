import { setTimeout as sleep } from "node:timers/promises";
import type {
  MessageBroker,
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
 *
 * Beside those rounds, every relayIntervalMs it relays the store's saved
 * messages to the message broker, which is how workers get their hints. A relay
 * that fails, because the broker or the store is unreachable, leaves the
 * messages saved and tries again after errorBackoffMs.
 *
 * Any number of orchestrators can run at once.
 */
export async function runOrchestrator({
  store,
  messageBroker,
  settings,
  stopSignal,
  workflows,
  scheduledRunFor,
}: {
  store: WorkflowStore;
  messageBroker: MessageBroker;
  settings: WorkflowEngineSettings;
  stopSignal: AbortSignal;
  workflows: WorkflowDefinition[];
  /** Works out a due schedule's run. See WorkflowStore.fireDueSchedules. */
  scheduledRunFor: (schedule: { workflow: string; name: string; input: unknown }) => ScheduledRun;
}) {
  const { sweepIntervalMs, relayIntervalMs, errorBackoffMs } = settings;

  /** Waits, but wakes up as soon as the orchestrator is told to stop. */
  const wait = (ms: number) => sleep(ms, undefined, { signal: stopSignal }).catch(() => {});

  console.log(
    `[orchestrator] sweeping expired leases and firing due schedules every ${sweepIntervalMs}ms, relaying messages every ${relayIntervalMs}ms`,
  );

  /** The relay, which runs beside the rounds below until the orchestrator stops. */
  async function relayLoop() {
    while (!stopSignal.aborted) {
      try {
        await store.relayMessages({ publish: (message) => messageBroker.publish(message) });
        await wait(relayIntervalMs);
      } catch (err) {
        console.error("[orchestrator] relay failed:", err instanceof Error ? err.message : err);
        await wait(errorBackoffMs);
      }
    }
  }
  const relaying = relayLoop();

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
  await relaying;

  console.log("[orchestrator] stopped");
}
