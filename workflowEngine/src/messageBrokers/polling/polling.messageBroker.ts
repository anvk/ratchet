import type { EngineMessage, MessageBroker } from "../../workflowEngine.types.ts";

/** How often a polling broker tells its subscribers to look for work, unless told otherwise. */
const DEFAULT_EVERY_MS = 250;

/**
 * A message broker that carries nothing between processes. Instead it tells
 * its own subscribers `step_ready` every `everyMs`, so each worker asks the
 * store for work on a timer: polling. What is published goes nowhere, so a
 * worker hears about a cancel at its next heartbeat.
 *
 * It needs nothing beside the store, and nothing can go missing: a worker is
 * told to look whether or not there is anything to find. The cost is a claim
 * query from every idle worker every `everyMs` (four times a second by
 * default), and a ready step waiting up to that long.
 */
export function createPollingMessageBroker({
  everyMs = DEFAULT_EVERY_MS,
}: { everyMs?: number } = {}): MessageBroker {
  const listeners = new Set<(message: EngineMessage) => void>();
  let timer: NodeJS.Timeout | undefined;

  return {
    publish: async () => {},
    async subscribe(listener) {
      listeners.add(listener);
      timer ??= setInterval(() => {
        for (const subscriber of listeners) subscriber({ type: "step_ready" });
      }, everyMs);
    },
    async close() {
      clearInterval(timer);
    },
  };
}
