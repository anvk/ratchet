import type { WorkflowEngine } from "@ratchet/engine";
import type { FastifyInstance } from "fastify";
import type {
  ErrorResponse,
  EventsResponse,
  RunDetail,
  RunsResponse,
  StartRunResponse,
} from "../api.types.ts";
import { toJson } from "../api.utils.ts";
import { getRun, listRunEvents, listRuns } from "./runs.queries.ts";
import { listRunsQuery, runParams, startRunBody } from "./runs.schemas.ts";

/**
 * Starting runs and reading them back. Reads go straight to the database;
 * starting a run goes through the engine, so its transaction and events stay intact.
 */
export function runsRoutes(app: FastifyInstance, engine: WorkflowEngine) {
  app.post("/runs", async (req, reply) => {
    const { workflow, input, idempotency_key } = startRunBody.parse(req.body);
    const definition = engine.registry.get(workflow);
    if (!definition) {
      const body: ErrorResponse = { error: "Unknown workflow" };
      return reply.code(400).send(body);
    }
    const id = await engine.startRun({
      definition,
      input: input ?? {},
      idempotencyKey: idempotency_key,
    });
    const body: StartRunResponse = { id };
    return reply.code(201).send(body);
  });

  app.get("/runs", async (req): Promise<RunsResponse> =>
    toJson(await listRuns(listRunsQuery.parse(req.query))),
  );

  app.get("/runs/:id", async (req, reply) => {
    const { id } = runParams.parse(req.params);
    const run = await getRun(id);
    if (!run) {
      const body: ErrorResponse = { error: "Run not found" };
      return reply.code(404).send(body);
    }
    const body: RunDetail = toJson(run);
    return body;
  });

  app.get("/runs/:id/events", async (req): Promise<EventsResponse> => {
    const { id } = runParams.parse(req.params);
    return toJson({ events: await listRunEvents(id) });
  });
}
