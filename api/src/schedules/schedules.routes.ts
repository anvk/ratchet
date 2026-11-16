import { InvalidScheduleError, UnknownWorkflowError, type WorkflowEngine } from "@ratchet/engine";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ErrorResponse, ScheduleRef, SchedulesResponse } from "../api.types.ts";
import type { ApiOptions } from "../app.ts";
import { toJson, workflowLabel } from "../api.utils.ts";
import { getSchedule, listSchedules } from "./schedules.queries.ts";
import { createScheduleBody, scheduleParams, updateScheduleBody } from "./schedules.schemas.ts";

/** Sends an ErrorResponse with the given status. */
function sendError({
  reply,
  status,
  error,
}: {
  reply: FastifyReply;
  status: number;
  error: string;
}) {
  const body: ErrorResponse = { error };
  return reply.code(status).send(body);
}

/**
 * Reading schedules, and creating, changing, pausing, resuming and deleting
 * them. Reads go straight to the database; every change goes through the
 * engine, which validates it. Titles come from the app's labels.
 */
export function schedulesRoutes({
  app,
  engine,
  labels,
}: { app: FastifyInstance; engine: WorkflowEngine } & Pick<ApiOptions, "labels">) {
  app.get("/schedules", async (): Promise<SchedulesResponse> => {
    const schedules = await listSchedules();
    return toJson({
      schedules: schedules.map((schedule) => ({
        ...schedule,
        workflow_title: workflowLabel({ labels, workflow: schedule.workflow }).title,
      })),
    });
  });

  app.post("/schedules", async (req, reply) => {
    const { workflow, name, cron, at, input } = createScheduleBody.parse(req.body);
    try {
      if (!(await engine.schedules.create({ workflow, name, cron, at, input }))) {
        return sendError({
          reply,
          status: 409,
          error: `Workflow ${workflow} already has a schedule named ${name}`,
        });
      }
    } catch (err) {
      if (!(err instanceof UnknownWorkflowError || err instanceof InvalidScheduleError)) throw err;
      return sendError({ reply, status: 400, error: err.message });
    }
    const body: ScheduleRef = { workflow, name };
    return reply.code(201).send(body);
  });

  app.patch("/schedules/:workflow/:name", async (req, reply) => {
    const { workflow, name } = scheduleParams.parse(req.params);
    const { cron, at, input } = updateScheduleBody.parse(req.body);
    try {
      if (!(await engine.schedules.update({ workflow, name, cron, at, input }))) {
        return sendError({
          reply,
          status: 404,
          error: "Schedule not found, or it fires once and already has",
        });
      }
    } catch (err) {
      if (!(err instanceof UnknownWorkflowError || err instanceof InvalidScheduleError)) throw err;
      return sendError({ reply, status: 400, error: err.message });
    }
    const body: ScheduleRef = { workflow, name };
    return body;
  });

  app.delete("/schedules/:workflow/:name", async (req, reply) => {
    const { workflow, name } = scheduleParams.parse(req.params);
    if (!(await engine.schedules.delete({ workflow, name }))) {
      return sendError({ reply, status: 404, error: "Schedule not found" });
    }
    const body: ScheduleRef = { workflow, name };
    return body;
  });

  // The engine's false means "missing or already in that state", so the
  // schedule is looked up to tell the two apart.
  app.post("/schedules/:workflow/:name/pause", async (req, reply) => {
    const { workflow, name } = scheduleParams.parse(req.params);
    if (!(await getSchedule({ workflow, name }))) {
      return sendError({ reply, status: 404, error: "Schedule not found" });
    }
    if (!(await engine.schedules.pause({ workflow, name }))) {
      return sendError({ reply, status: 409, error: "The schedule is already paused" });
    }
    const body: ScheduleRef = { workflow, name };
    return body;
  });

  app.post("/schedules/:workflow/:name/resume", async (req, reply) => {
    const { workflow, name } = scheduleParams.parse(req.params);
    if (!(await getSchedule({ workflow, name }))) {
      return sendError({ reply, status: 404, error: "Schedule not found" });
    }
    if (!(await engine.schedules.resume({ workflow, name }))) {
      return sendError({ reply, status: 409, error: "The schedule isn't paused" });
    }
    const body: ScheduleRef = { workflow, name };
    return body;
  });
}
