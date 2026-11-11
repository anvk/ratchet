import type { PillTone } from "../components/Pill";

/**
 * The colour of each event type in a run's history: green for successes, red
 * for failures, blue for work starting (including a failed run resumed), amber for a step that will run again
 * (a retry, or a lease lost by a silent worker), and grey for waiting or for
 * steps that won't run. Unknown types show grey.
 */
export const EVENT_TONES: Record<string, PillTone> = {
  run_queued: "grey",
  run_started: "blue",
  run_succeeded: "green",
  run_failed: "red",
  run_redriven: "blue",
  step_ready: "grey",
  step_claimed: "blue",
  step_succeeded: "green",
  step_failed: "red",
  step_skipped: "grey",
  step_lease_expired: "amber",
  step_retry_scheduled: "amber",
};
