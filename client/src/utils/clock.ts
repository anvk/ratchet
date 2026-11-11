/** A ticking clock that components can subscribe to, in the shape useSyncExternalStore expects. */
export interface Clock {
  /** Starts listening; returns the function that stops. */
  subscribe: (listener: () => void) => () => void;
  /** The time at the last tick, in ms since the epoch. */
  getSnapshot: () => number;
}

/**
 * A clock that ticks every intervalMs, but only while someone is listening:
 * the timer starts with the first subscriber and stops with the last, so an
 * idle page runs no timers at all.
 */
export function createClock({
  intervalMs,
  readTime = Date.now,
}: {
  intervalMs: number;
  readTime?: () => number;
}): Clock {
  const listeners = new Set<() => void>();
  let now = readTime();
  let timer: ReturnType<typeof setInterval> | undefined;

  const tick = () => {
    now = readTime();
    for (const listener of listeners) listener();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        // The clock may have been idle for a while: catch up before the first tick.
        now = readTime();
        timer = setInterval(tick, intervalMs);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
    getSnapshot: () => now,
  };
}

const sharedClocks = new Map<number, Clock>();

/**
 * The app-wide clock for an interval. Everything that ticks at the same rate
 * shares one timer, so all of them update in the same instant.
 */
export function sharedClock(intervalMs: number): Clock {
  let clock = sharedClocks.get(intervalMs);
  if (!clock) {
    clock = createClock({ intervalMs });
    sharedClocks.set(intervalMs, clock);
  }
  return clock;
}
