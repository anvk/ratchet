import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ScheduleRef } from "@ratchet/api/types";
import { QUERY_KEYS } from "../../queryKeys";
import { pauseSchedule } from "../../services/workflows.service";

/** Pauses a schedule: it skips its ticks until resumed. */
export function usePauseSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (schedule: ScheduleRef) => pauseSchedule(schedule),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEYS.schedules.list() }),
  });
}
