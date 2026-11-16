import type { FastifyInstance } from "fastify";
import type { SchedulesResponse } from "../api.types.ts";
import type { ApiOptions } from "../app.ts";
import { toJson, workflowLabel } from "../api.utils.ts";
import { listSchedules } from "./schedules.queries.ts";

/** `GET /schedules`: every schedule in the database, with the app's workflow titles. */
export function schedulesRoutes({
  app,
  labels,
}: { app: FastifyInstance } & Pick<ApiOptions, "labels">) {
  app.get("/schedules", async (): Promise<SchedulesResponse> => {
    const schedules = await listSchedules();
    return toJson({
      schedules: schedules.map((schedule) => ({
        ...schedule,
        workflow_title: workflowLabel({ labels, workflow: schedule.workflow }).title,
      })),
    });
  });
}
