import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import type { EngineMessage, MessageBroker } from "../../workflowEngine.types.ts";

/** The one channel every message travels on, as JSON. */
const CHANNEL = "ratchet_messages";

/** How long to wait before trying to listen again after the connection is lost. */
const RECONNECT_MS = 1000;

/** How often subscribers are told to look for work whatever has been heard, unless told otherwise. */
const DEFAULT_EVERY_MS = 30_000;

/**
 * A message broker built on Postgres LISTEN/NOTIFY, connecting to DATABASE_URL.
 * Postgres passes each published message to every connection that is
 * listening, whichever process it belongs to, so processes need nothing in
 * common but the database.
 *
 * It holds up to two connections: one for publishing, opened on first use, and
 * one that listens, opened by the first subscribe. The listening one must be a
 * direct connection: a pooler that hands connections out per transaction can't
 * deliver notifications.
 *
 * Postgres hands a notification to every connection listening at that moment,
 * and keeps none for a connection that isn't there. If the listening
 * connection drops, this connects again by itself and tells every subscriber
 * `step_ready`, since it can't know what it missed.
 *
 * It also tells every subscriber `step_ready` every `everyMs` (30 seconds by
 * default) whatever it has heard. Nothing known needs it; it is there so that
 * a message missed in some way nobody foresaw makes a step late, not stuck.
 */
export function createPostgresMessageBroker({
  everyMs = DEFAULT_EVERY_MS,
}: { everyMs?: number } = {}): MessageBroker {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env.");
  }

  const publisher = new pg.Pool({ connectionString, max: 1 });
  // Without a listener, the idle connection dropping would crash the process.
  publisher.on("error", (err) => console.error("[message broker] publisher error:", err.message));

  const listeners = new Set<(message: EngineMessage) => void>();
  let listener: pg.Client | undefined;
  let listening: Promise<void> | undefined;
  let tick: NodeJS.Timeout | undefined;
  let closed = false;

  /** Hands a message to every subscriber. */
  function deliver(message: EngineMessage) {
    for (const subscriber of listeners) subscriber(message);
  }

  /** Opens the listening connection and starts passing its notifications on. */
  async function listen() {
    const client = new pg.Client({ connectionString });
    client.on("notification", ({ payload }) => {
      if (payload) deliver(JSON.parse(payload) as EngineMessage);
    });
    // A lost connection reports an error, an end, or both. Only the first one
    // for the connection in use starts a reconnect.
    const lost = (reason: string) => {
      if (closed || listener !== client) return;
      listener = undefined;
      console.error(`[message broker] stopped listening (${reason}); connecting again`);
      void reconnect();
    };
    client.on("error", (err) => lost(err.message));
    client.on("end", () => lost("connection ended"));
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
    } catch (err) {
      await client.end().catch(() => {});
      throw err;
    }
    if (closed) {
      await client.end();
      return;
    }
    listener = client;
  }

  /** Keeps trying to listen again until it works or the broker is closed. */
  async function reconnect() {
    while (!closed) {
      await sleep(RECONNECT_MS);
      if (closed) return;
      try {
        await listen();
        console.log("[message broker] listening again");
        // Whatever was published in between is gone, so have workers look.
        deliver({ type: "step_ready" });
        return;
      } catch (err) {
        console.error(
          "[message broker] could not listen:",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  return {
    async publish(message) {
      await publisher.query("SELECT pg_notify($1, $2)", [CHANNEL, JSON.stringify(message)]);
    },
    async subscribe(subscriber) {
      listeners.add(subscriber);
      tick ??= setInterval(() => deliver({ type: "step_ready" }), everyMs);
      listening ??= listen();
      try {
        await listening;
      } catch (err) {
        // So a later subscribe tries again instead of repeating this failure.
        listening = undefined;
        listeners.delete(subscriber);
        throw err;
      }
    },
    async close() {
      closed = true;
      clearInterval(tick);
      await listener?.end();
      await publisher.end();
    },
  };
}
