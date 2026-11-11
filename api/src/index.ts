import type { WorkflowEngine } from "@ratchet/engine";
import { buildApp, type ApiOptions } from "./app.ts";

export type { ApiOptions } from "./app.ts";

/** Serves the HTTP API that clients such as the dashboard use, until SIGINT or SIGTERM. */
export async function startApi(engine: WorkflowEngine, options: ApiOptions = {}) {
  const app = buildApp(engine, options);
  const port = Number(process.env.PORT ?? 4000);
  await app.listen({ port, host: "127.0.0.1" });
  console.log(`API listening on http://127.0.0.1:${port}`);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      app
        .close()
        .then(() => engine.close())
        .catch((err) => console.error("API close failed:", err))
        .finally(() => process.exit());
    });
  }
}
