import { useMutation, useQueryClient } from "@tanstack/react-query";
import { QUERY_KEYS } from "../../queryKeys";
import { redriveRun } from "../../services/workflows.service";

/** Resumes a failed run from the steps that didn't succeed. */
export function useRedriveRun({ id }: { id: string }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => redriveRun(id),
    // The run is running again, so start polling it and its history.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEYS.runs.details({ id }) }),
  });
}
