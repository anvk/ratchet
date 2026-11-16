import type { FastifyReply, FastifyRequest } from "fastify";
import { sendError } from "../api.utils.ts";

/** Answers unknown routes in the same shape as every other error. */
export function notFound(req: FastifyRequest, reply: FastifyReply) {
  return sendError({ reply, status: 404, error: `No route for ${req.method} ${req.url}` });
}
