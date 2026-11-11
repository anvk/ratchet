import { useQuery } from "@tanstack/react-query";
import type { WorkflowRunStatus } from "@ratchet/engine/constants";
import { QUERY_KEYS } from "../../queryKeys";
import { fetchRuns } from "../../services/workflows.service";

/** One page of the runs list with counts per status, refreshed every 2 seconds. */
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
    refetchInterval: 2000,
  });
}
