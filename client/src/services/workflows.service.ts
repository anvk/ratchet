import type {
  EventsResponse,
  RunDetail,
  RunsResponse,
  ScheduleRef,
  SchedulesResponse,
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

/** Resumes a failed run from the steps that didn't succeed. */
export const redriveRun = (id: string) => api.post<StartRunResponse>(`/runs/${id}/redrive`, {});

/** Stops a run that hasn't finished. */
export const cancelRun = (id: string) => api.post<StartRunResponse>(`/runs/${id}/cancel`, {});

/** Returns a run and its steps. */
export const fetchRun = (id: string) => api.get<RunDetail>(`/runs/${id}`);

/** Returns a run's history, oldest first. */
export const fetchEvents = (id: string) =>
  api.get<EventsResponse>(`/runs/${id}/events`).then((r) => r.events);

/** Lists every schedule, with when it next fires. */
export const fetchSchedules = () =>
  api.get<SchedulesResponse>("/schedules").then((r) => r.schedules);

/** Stops a schedule from firing; its ticks are skipped until it is resumed. */
export const pauseSchedule = ({ workflow, name }: ScheduleRef) =>
  api.post<ScheduleRef>(
    `/schedules/${encodeURIComponent(workflow)}/${encodeURIComponent(name)}/pause`,
    {},
  );

/** Lets a paused schedule fire again, from its next tick. */
export const resumeSchedule = ({ workflow, name }: ScheduleRef) =>
  api.post<ScheduleRef>(
    `/schedules/${encodeURIComponent(workflow)}/${encodeURIComponent(name)}/resume`,
    {},
  );
