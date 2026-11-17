import { useQuery } from "@tanstack/react-query";
import { REFETCH_INTERVAL_MS } from "../../constants/polling";
import { QUERY_KEYS } from "../../queryKeys";
import { fetchSchedules } from "../../services/workflows.service";

/** Every schedule with when it next fires, refreshed on an interval. */
export function useSchedules() {
  return useQuery({
    queryKey: QUERY_KEYS.schedules.list(),
    queryFn: fetchSchedules,
    refetchInterval: REFETCH_INTERVAL_MS.schedules,
  });
}
