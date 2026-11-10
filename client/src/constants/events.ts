import type { PillTone } from "../components/Pill";

/**
 * The colour of each event type in a run's history: green for successes, red
 * for failures, blue for work starting, amber for a step taken away from a
 * silent worker, and grey for waiting. Unknown types show grey.
 */
export const EVENT_TONES: Record<string, PillTone> = {
  run_queued: "grey",
  run_started: "blue",
  run_succeeded: "green",
  run_failed: "red",
  step_ready: "grey",
  step_claimed: "blue",
  step_succeeded: "green",
  step_failed: "red",
  step_skipped: "grey",
  step_lease_expired: "amber",
};
