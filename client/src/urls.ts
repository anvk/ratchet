import type { WorkflowRunStatus } from "@ratchet/engine/constants";
import { assembleUrl } from "./utils/url";

/**
 * Every page in the dashboard, as functions that build its URL. Links,
 * navigate() calls and the routes in main.tsx all use these, so a path is
 * only written once.
 */
export const URLS = {
  runs: {
    /** The runs list, optionally filtered to one status. */
    list: (params?: { status?: WorkflowRunStatus }) => assembleUrl("/", { status: params?.status }),
    /**
     * One run's page. Called with `{ id: ":id" }`, it gives the route pattern,
     * which is how main.tsx defines the route.
     */
    details: (params: { id: string }) => assembleUrl(`/runs/${params.id}`, {}),
  },
};
