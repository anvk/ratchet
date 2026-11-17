import { useMutation, useQueryClient } from "@tanstack/react-query";
import { QUERY_KEYS } from "../../queryKeys";
import { startRun } from "../../services/workflows.service";

/**
 * Starts `count` runs of a workflow with the same input, then refreshes the
 * runs list. Resolves to the new runs' ids.
 */
export function useStartRuns() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workflow, input, count }: { workflow: string; input: object; count: number }) =>
      Promise.all(Array.from({ length: count }, () => startRun(workflow, input))),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEYS.runs.lists() }),
  });
}
