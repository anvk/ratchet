import { useMutation, useQueryClient } from "@tanstack/react-query";
import { QUERY_KEYS } from "../../queryKeys";
import { cancelRun } from "../../services/workflows.service";

/** Stops a run that hasn't finished. */
export function useCancelRun({ id }: { id: string }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => cancelRun(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEYS.runs.details({ id }) }),
  });
}
