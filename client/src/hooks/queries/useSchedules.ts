import { useQuery } from "@tanstack/react-query";
import { QUERY_KEYS } from "../../queryKeys";
import { fetchSchedules } from "../../services/workflows.service";

/** Every schedule with when it next fires, refreshed every 5 seconds. */
export function useSchedules() {
  return useQuery({
    queryKey: QUERY_KEYS.schedules.list(),
    queryFn: fetchSchedules,
    refetchInterval: 5000,
  });
}
