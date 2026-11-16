import { UnknownWorkflowError, type WorkflowEngine } from "@ratchet/engine";
import type { FastifyInstance } from "fastify";
import type { EventsResponse, RunDetail, RunsResponse, StartRunResponse } from "../api.types.ts";
import type { ApiOptions } from "../app.ts";
import { sendError, stepLabel, toJson, workflowLabel } from "../api.utils.ts";
import { getRun, listRunEvents, listRuns } from "./runs.queries.ts";
import { listRunsQuery, runParams, startRunBody } from "./runs.schemas.ts";

/**
 * Starting runs and reading them back. Reads go straight to the database;
 * starting a run goes through the engine, so its transaction and events stay intact.
 * Titles and descriptions come from the app's labels, not the database.
 */
export function runsRoutes({
  app,
  engine,
  labels,
}: { app: FastifyInstance; engine: WorkflowEngine } & Pick<ApiOptions, "labels">) {
  app.post("/runs", async (req, reply) => {
    const { workflow, input, idempotency_key } = startRunBody.parse(req.body);
    try {
      const id = await engine.startRun({
        workflow,
        input: input ?? {},
        idempotencyKey: idempotency_key,
      });
      const body: StartRunResponse = { id };
      return reply.code(201).send(body);
    } catch (err) {
      if (!(err instanceof UnknownWorkflowError)) throw err;
      return sendError({ reply, status: 400, error: err.message });
    }
  });

  app.get("/runs", async (req): Promise<RunsResponse> => {
    const { runs, ...rest } = await listRuns(listRunsQuery.parse(req.query));
    return toJson({
      ...rest,
      runs: runs.map((run) => ({
        ...run,
        workflow_title: workflowLabel({ labels, workflow: run.workflow }).title,
      })),
    });
  });

  app.get("/runs/:id", async (req, reply) => {
    const { id } = runParams.parse(req.params);
    const run = await getRun(id);
    if (!run) {
      return sendError({ reply, status: 404, error: "Run not found" });
    }
    const { title, description } = workflowLabel({ labels, workflow: run.run.workflow });
    const body: RunDetail = toJson({
      run: { ...run.run, workflow_title: title, workflow_description: description },
      steps: run.steps.map((step) => ({
        ...step,
        ...stepLabel({ labels, workflow: run.run.workflow, step: step.name }),
      })),
    });
    return body;
  });

  // Through the engine too: resuming a run changes its steps and writes events.
  app.post("/runs/:id/redrive", async (req, reply) => {
    const { id } = runParams.parse(req.params);
    if (!(await getRun(id))) {
      return sendError({ reply, status: 404, error: "Run not found" });
    }
    if (!(await engine.redriveRun(id))) {
      return sendError({
        reply,
        status: 409,
        error: "Only a cancelled run, or one that failed for a redrivable reason, can be redriven",
      });
    }
    const body: StartRunResponse = { id };
    return body;
  });

  // Through the engine too: cancelling a run changes its steps and writes events.
  app.post("/runs/:id/cancel", async (req, reply) => {
    const { id } = runParams.parse(req.params);
    if (!(await getRun(id))) {
      return sendError({ reply, status: 404, error: "Run not found" });
    }
    if (!(await engine.cancelRun(id))) {
      return sendError({
        reply,
        status: 409,
        error: "Only a run that hasn't finished can be cancelled",
      });
    }
    const body: StartRunResponse = { id };
    return body;
  });

  app.get("/runs/:id/events", async (req): Promise<EventsResponse> => {
    const { id } = runParams.parse(req.params);
    return toJson({ events: await listRunEvents(id) });
  });
}
