import { useQuery } from "@tanstack/react-query";
import { QUERY_KEYS } from "../../queryKeys";
import { fetchEvents } from "../../services/workflows.service";

/**
 * One run's history, refreshed twice a second while the run is going. Once it
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
    refetchInterval: finished ? false : 500,
  });
}
