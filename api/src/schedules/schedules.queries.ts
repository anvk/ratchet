import { db } from "@ratchet/engine/postgres";

// The read side, like runs.queries.ts: only ever SELECTs.

const SCHEDULE_COLUMNS = [
  "workflow",
  "name",
  "cron",
  "input",
  "paused_at",
  "next_fire_at",
  "last_fired_at",
] as const;

export function listSchedules() {
  return db
    .selectFrom("schedules")
    .select(SCHEDULE_COLUMNS)
    .orderBy("workflow")
    .orderBy("name")
    .execute();
}

/** One schedule, or undefined if the workflow has none with this name. */
export function getSchedule({ workflow, name }: { workflow: string; name: string }) {
  return db
    .selectFrom("schedules")
    .select(SCHEDULE_COLUMNS)
    .where("workflow", "=", workflow)
    .where("name", "=", name)
    .executeTakeFirst();
}
