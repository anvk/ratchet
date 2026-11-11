import { useQuery } from "@tanstack/react-query";
import { QUERY_KEYS } from "../../queryKeys";
import { fetchRun } from "../../services/workflows.service";
import { isRunFinished } from "../../utils/runs";

/** One run with its steps, refreshed twice a second until it finishes. */
export function useRun({ id }: { id: string }) {
  return useQuery({
    queryKey: QUERY_KEYS.runs.details({ id }),
    queryFn: () => fetchRun(id),
    retry: false,
    // Finished runs can't change, so stop polling them.
    refetchInterval: (query) => {
      if (query.state.error) return false;
      const status = query.state.data?.run.status;
      return status && isRunFinished(status) ? false : 500;
    },
  });
}
