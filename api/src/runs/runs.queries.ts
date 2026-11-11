import { WORKFLOW_RUN_STATUSES } from "@ratchet/engine";
import { db, type WorkflowRunStatus } from "@ratchet/engine/postgres";
import { sql } from "kysely";
import { encodeCursor } from "./runs.schemas.ts";

// The read side: shapes the client needs. These only ever SELECT. Every state
// change goes through the engine, so its transactions and events stay intact.

export async function listRuns({
  status,
  cursor,
  limit,
}: {
  status?: WorkflowRunStatus;
  cursor?: { at: string; id: string };
  limit: number;
}) {
  let query = db
    .selectFrom("workflow_runs as r")
    .innerJoin("workflows as w", "w.id", "r.workflow_id")
    .select((eb) => [
      "r.id",
      "w.name as workflow",
      "w.title as workflow_title",
      "r.status",
      "r.failure_reason",
      "r.created_at",
      "r.started_at",
      "r.finished_at",
      // Formatted in SQL to keep the microseconds a JavaScript Date would
      // lose, which would otherwise make the cursor skip or repeat rows.
      sql<string>`to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
        "cursor_at",
      ),
      // A count is never null, but Kysely types any subquery as nullable.
      eb.fn
        .coalesce(
          eb
            .selectFrom("step_runs as s")
            .whereRef("s.run_id", "=", "r.id")
            .select(sql<number>`count(*)::int`.as("n")),
          sql<number>`0`,
        )
        .as("steps_total"),
      eb.fn
        .coalesce(
          eb
            .selectFrom("step_runs as s")
            .whereRef("s.run_id", "=", "r.id")
            .where("s.status", "=", "succeeded")
            .select(sql<number>`count(*)::int`.as("n")),
          sql<number>`0`,
        )
        .as("steps_done"),
    ])
    .orderBy("r.created_at", "desc")
    .orderBy("r.id", "desc")
    .limit(limit + 1);

  if (status) query = query.where("r.status", "=", status);
  if (cursor) {
    query = query.where(
      sql<boolean>`(r.created_at, r.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`,
    );
  }

  const rows = await query.execute();
  const page = rows.slice(0, limit);
  const last = page.at(-1);

  const countRows = await db
    .selectFrom("workflow_runs")
    .select(["status", sql<number>`count(*)::int`.as("count")])
    .groupBy("status")
    .execute();

  return {
    runs: page.map(({ cursor_at, ...run }) => run),
    next_cursor: rows.length > limit && last ? encodeCursor(last.cursor_at, last.id) : null,
    counts: Object.fromEntries(
      WORKFLOW_RUN_STATUSES.map((s) => [s, countRows.find((row) => row.status === s)?.count ?? 0]),
    ) as Record<WorkflowRunStatus, number>,
  };
}

export async function getRun(id: string) {
  const run = await db
    .selectFrom("workflow_runs as r")
    .innerJoin("workflows as w", "w.id", "r.workflow_id")
    .select([
      "r.id",
      "r.status",
      "r.failure_reason",
      "r.input",
      "r.created_at",
      "r.started_at",
      "r.finished_at",
      "w.name as workflow",
      "w.version as workflow_version",
      "w.title as workflow_title",
      "w.description as workflow_description",
    ])
    .where("r.id", "=", id)
    .executeTakeFirst();
  if (!run) return undefined;

  const steps = await db
    .selectFrom("step_runs as sr")
    .leftJoin("steps as s", "s.id", "sr.step_id")
    .select([
      "sr.name",
      // A step added at runtime has no plan row to take a title from.
      sql<string>`coalesce(s.title, sr.name)`.as("title"),
      "s.description",
      "sr.position",
      "sr.needs",
      "sr.status",
      "sr.attempt",
      "sr.worker_id",
      "sr.output",
      "sr.error",
      "sr.failure_reason",
      "sr.ready_at",
      "sr.started_at",
      "sr.finished_at",
    ])
    .where("sr.run_id", "=", id)
    .orderBy("sr.position")
    .execute();

  return { run, steps };
}

export function listRunEvents(runId: string) {
  return db
    .selectFrom("events")
    .select(["id", "step_name", "type", "attempt", "worker_id", "detail", "at"])
    .where("run_id", "=", runId)
    .orderBy("id")
    .execute();
}
