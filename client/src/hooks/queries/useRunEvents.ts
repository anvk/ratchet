import { useQuery } from "@tanstack/react-query";
import { REFETCH_INTERVAL_MS } from "../../constants/polling";
import { QUERY_KEYS } from "../../queryKeys";
import { fetchEvents } from "../../services/workflows.service";

/**
 * One run's history, refreshed on an interval while the run is going. Once it
 * finishes, the events are fetched one last time and polling stops.
 */
export function useRunEvents({
  id,
  finished,
  enabled,
}: {
  id: string;
  finished: boolean;
  enabled: boolean;
}) {
  return useQuery({
    queryKey: QUERY_KEYS.runs.events({ id, finished }),
    queryFn: () => fetchEvents(id),
    enabled,
    refetchInterval: finished ? false : REFETCH_INTERVAL_MS.runEvents,
  });
}
