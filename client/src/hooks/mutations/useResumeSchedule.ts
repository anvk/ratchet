import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ScheduleRef } from "@ratchet/api/types";
import { QUERY_KEYS } from "../../queryKeys";
import { resumeSchedule } from "../../services/workflows.service";

/** Resumes a paused schedule from its next tick, without running the ticks it skipped. */
export function useResumeSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (schedule: ScheduleRef) => resumeSchedule(schedule),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEYS.schedules.list() }),
  });
}
