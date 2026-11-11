/**
 * How long something took, or has taken so far at `now` if it hasn't ended.
 * Takes the time as an input, rather than reading the clock, so it stays pure.
 */
export function formatDuration({
  start,
  end,
  now,
}: {
  start: string | null;
  end: string | null;
  now: number;
}) {
  if (!start) return "–";
  const ms = (end ? new Date(end).getTime() : now) - new Date(start).getTime();
  const seconds = Math.max(ms, 0) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  // Round once, then split, so 119.6s reads "2m 0s" rather than "1m 60s".
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m ${whole % 60}s`;
}

/** How long before `now` something happened, like "5m ago". */
export function formatAge({ at, now }: { at: string | null; now: number }) {
  if (!at) return "–";
  const seconds = Math.max(Math.round((now - new Date(at).getTime()) / 1000), 0);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
