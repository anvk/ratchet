/** How often each query refetches while its page is open, in milliseconds. */
export const REFETCH_INTERVAL_MS = {
  /** The runs list and its status counts. */
  runs: 2000,
  /** One run and its steps, until the run finishes. */
  run: 500,
  /** One run's event history, until the run finishes. */
  runEvents: 500,
  /** The schedules list. */
  schedules: 5000,
} as const;
