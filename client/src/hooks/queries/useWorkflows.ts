import { useQuery } from "@tanstack/react-query";
import { QUERY_KEYS } from "../../queryKeys";
import { fetchWorkflows } from "../../services/workflows.service";

/** Every workflow that can be started, with its presets. */
export function useWorkflows() {
  return useQuery({
    queryKey: QUERY_KEYS.workflows.list(),
    queryFn: fetchWorkflows,
  });
}
