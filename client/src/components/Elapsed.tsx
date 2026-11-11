import { useNow } from "../hooks/useNow";
import { formatDuration } from "../utils/format";

/** Running durations tick ten times a second, so the tenths shown are real. */
const RUNNING_TICK_MS = 100;

/** A duration that is still growing: the only kind that needs a clock. */
function RunningElapsed({ start }: { start: string }) {
  const now = useNow(RUNNING_TICK_MS);
  return formatDuration({ start, end: null, now });
}

/**
 * How long something took, or has taken so far. Only an unfinished one
 * subscribes to the clock; a finished one never re-renders on its own.
 */
export function Elapsed({ start, end }: { start: string | null; end: string | null }) {
  if (start && !end) return <RunningElapsed start={start} />;
  // `now` is unused when the duration has ended or never started.
  return formatDuration({ start, end, now: 0 });
}
