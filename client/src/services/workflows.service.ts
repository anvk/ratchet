import type {
  EventsResponse,
  RunDetail,
  RunsResponse,
  StartRunResponse,
  WorkflowsResponse,
} from "@ratchet/api/types";
import type { WorkflowRunStatus } from "@ratchet/engine/constants";
import { api } from "./api";

/** Lists the workflows that can be started. */
export const fetchWorkflows = () =>
  api.get<WorkflowsResponse>("/workflows").then((r) => r.workflows);

/** Starts a run and returns its id. */
export const startRun = (workflow: string, input: object) =>
  api.post<StartRunResponse>("/runs", { workflow, input });

/** Lists runs, newest first, optionally of one status. Pass a page's next_cursor to get the next page. */
export function fetchRuns(status: WorkflowRunStatus | "all", cursor: string | null) {
  const params = new URLSearchParams();
  if (status !== "all") params.set("status", status);
  if (cursor) params.set("cursor", cursor);
  return api.get<RunsResponse>(`/runs?${params}`);
}

/** Returns a run and its steps. */
export const fetchRun = (id: string) => api.get<RunDetail>(`/runs/${id}`);

/** Returns a run's history, oldest first. */
export const fetchEvents = (id: string) =>
  api.get<EventsResponse>(`/runs/${id}/events`).then((r) => r.events);
