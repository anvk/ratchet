import type { WorkflowRunStatus } from "@ratchet/engine/constants";

/**
 * Every React Query key in the dashboard, as functions that build it. Queries
 * and invalidations both use these, so a key is only written once and an
 * invalidation can't miss the query it means.
 */
export const QUERY_KEYS = {
  runs: {
    /** Prefix of every page of the runs list, for invalidating them all. */
    lists: () => ["runs", "list"],
    /** One page of the runs list. */
    list: (params: { status: WorkflowRunStatus | "all"; cursor: string | null }) => [
      ...QUERY_KEYS.runs.lists(),
      params.status,
      params.cursor,
    ],
    /** One run with its steps. */
    details: (params: { id: string }) => ["runs", "details", params.id],
    /**
     * One run's events. `finished` is part of the key so the list is fetched
     * once more when the run finishes, and polling stops after that.
     */
    events: (params: { id: string; finished: boolean }) => [
      "runs",
      "events",
      params.id,
      params.finished,
    ],
  },
  workflows: {
    /** Every workflow the API knows, with its presets. */
    list: () => ["workflows", "list"],
  },
};
