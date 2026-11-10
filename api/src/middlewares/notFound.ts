import type { FastifyReply, FastifyRequest } from "fastify";
import type { ErrorResponse } from "../api.types.ts";

/** Answers unknown routes in the same shape as every other error. */
export function notFound(req: FastifyRequest, reply: FastifyReply) {
  const body: ErrorResponse = { error: `No route for ${req.method} ${req.url}` };
  return reply.code(404).send(body);
}
