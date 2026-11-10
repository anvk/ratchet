import { Kysely, PostgresDialect, type Transaction } from "kysely";
import pg from "pg";
import type { DB } from "./schema.gen.ts";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env.");
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

// Without a listener, an idle connection dropping (say, Postgres restarting)
// would crash the whole process.
pool.on("error", (err) => console.error("idle database connection error:", err.message));

export const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

export type Tx = Transaction<DB>;

export type { DB, WorkflowRunStatus } from "./schema.gen.ts";
