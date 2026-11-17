import { useQuery } from "@tanstack/react-query";
import type { WorkflowRunStatus } from "@ratchet/engine/constants";
import { REFETCH_INTERVAL_MS } from "../../constants/polling";
import { QUERY_KEYS } from "../../queryKeys";
import { fetchRuns } from "../../services/workflows.service";

/** One page of the runs list with counts per status, refreshed on an interval. */
export function useRuns({
  status,
  cursor,
}: {
  status: WorkflowRunStatus | "all";
  cursor: string | null;
}) {
  return useQuery({
    queryKey: QUERY_KEYS.runs.list({ status, cursor }),
    queryFn: () => fetchRuns(status, cursor),
    refetchInterval: REFETCH_INTERVAL_MS.runs,
  });
}
