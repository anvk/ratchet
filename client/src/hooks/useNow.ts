import { useSyncExternalStore } from "react";
import { sharedClock } from "../utils/clock";

/**
 * The current time, updated every intervalMs from a clock the whole app
 * shares. Anything shown relative to now ("4.2s", "5m ago") must read the time
 * from here rather than calling Date.now() while rendering: the React Compiler
 * treats rendering as pure and caches its results, so a value read from the
 * clock would never update.
 *
 * Call it from the smallest component that shows the time, so a tick only
 * re-renders that component and not the page around it.
 */
export function useNow(intervalMs: number) {
  const clock = sharedClock(intervalMs);
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot);
}
