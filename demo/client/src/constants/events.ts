import type { PillTone } from "../components/Pill";

/**
 * The colour of each event type in a run's history: green for successes, red
 * for failures, blue for work starting (including a failed or cancelled run
 * resumed, or a queued run getting its slot), amber for a step that will run
 * again (a retry, or a lease lost by a silent worker), and grey for waiting
 * (including a run whose group is full), for a cancelled run, or for steps and
 * schedule ticks that won't run. Unknown types show grey.
 */
export const EVENT_TONES: Record<string, PillTone> = {
  run_queued: "grey",
  run_waiting: "grey",
  run_admitted: "blue",
  run_started: "blue",
  run_succeeded: "green",
  run_failed: "red",
  run_cancelled: "grey",
  run_redriven: "blue",
  schedule_tick_skipped: "grey",
  step_ready: "grey",
  step_claimed: "blue",
  step_succeeded: "green",
  step_failed: "red",
  step_skipped: "grey",
  step_lease_expired: "amber",
  step_retry_scheduled: "amber",
};
