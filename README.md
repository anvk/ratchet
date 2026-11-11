# ratchet

## Run it

You need Node 22 or newer, pnpm 12 and a Docker runtime such as OrbStack.

```sh
cp .env.example .env
pnpm install
pnpm dev
```

Open <http://localhost:5173>, pick a workflow and press **Start run**. `pnpm dev` starts the demo: Postgres, the API, the orchestrator, three workers and the dashboard.
How it all works is explained in [`docs/how-the-engine-works-v4.md`](docs/how-the-engine-works-v4.md)
(earlier designs: [v1](docs/how-the-engine-works-v1.md), [v2](docs/how-the-engine-works-v2.md), [v3](docs/how-the-engine-works-v3.md)).

```sh
pnpm test        # engine tests against real Postgres and worker processes
pnpm typecheck   # TypeScript 7
pnpm lint        # oxlint, including type-aware rules such as no-floating-promises
pnpm format      # Prettier
pnpm check       # typecheck, lint and format check together
pnpm db:reset    # delete all local data and reapply the schema
pnpm db:types    # regenerate workflowEngine/src/stores/postgres/db/schema.gen.ts from the database
```

The example workflows are fake. No real money or payment provider is involved.

## Layout

The engine is one package. Everything else in the repo is a demo built on it,
to show it running; none of the demo is needed to use the engine.

**The engine**

| Path              | What's there                                                                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflowEngine/` | Workers, the orchestrator, leases, retries, the registry and the `WorkflowStore` interface, with Postgres in `src/stores/postgres/`. What it promises is in `guarantees.md` |
| `docs/`           | Walkthroughs of how the engine works, for newcomers. `how-the-engine-works-v4.md` describes the current engine                                                              |

**Demo only**

| Path         | What's there                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| `workflows/` | Fake payment and greeting workflows, and the processes that run them (`api.ts`, `worker.ts`, `orchestrator.ts`) |
| `api/`       | HTTP API for the dashboard. Reads the engine's tables directly and makes every change through the engine        |
| `client/`    | The dashboard: runs list, live step diagram and event log, driven only by the HTTP API                          |

## Use the engine

A workflow is a list of named steps. Each step is an async function, and
`needs` says which steps must succeed before it starts:

```ts
import { defineWorkflow } from "@ratchet/engine";

export interface StockReportInput {
  ticker: string;
}

export default defineWorkflow<StockReportInput>({
  name: "stock-report",
  title: "Stock report",
  description: "Builds a short report on a stock.",
  steps: [
    {
      name: "fetch-prices",
      title: "Fetch prices",
      description: "Loads recent prices.",
      async run() {
        return { prices: [] };
      },
    },
    {
      name: "fetch-news",
      title: "Fetch news",
      description: "Loads recent headlines, alongside the prices.",
      needs: [], // needs nothing, so it starts with fetch-prices
      async run() {
        return { headlines: [] };
      },
    },
    {
      name: "write-report",
      title: "Write report",
      description: "Combines prices and news.",
      needs: ["fetch-prices", "fetch-news"], // waits for both
      async run(ctx) {
        const { prices } = ctx.outputs["fetch-prices"];
        const { headlines } = ctx.outputs["fetch-news"];
        return { ticker: ctx.input.ticker, prices, headlines };
      },
    },
  ],
});
```

An engine pairs your workflows with a store, which keeps their state in
Postgres (`DATABASE_URL`). Start runs from anywhere; run workers in as many
processes as you like, and one orchestrator:

```ts
import { closeOnSignals, createWorkflowEngine } from "@ratchet/engine";
import { createPostgresStore } from "@ratchet/engine/postgres";
import stockReport from "./stockReport.ts";

const engine = createWorkflowEngine({ workflows: [stockReport], store: createPostgresStore() });

// Once per deploy: save each workflow's plan, so runs can be started.
await engine.sync();
const runId = await engine.startRun({ workflow: "stock-report", input: { ticker: "AAPL" } });

// In a worker process: claim and run steps until stopped.
closeOnSignals(engine);
await engine.runWorker();

// In one process: give steps whose worker went silent to another worker.
await engine.runOrchestrator();
```

The `workflows/` folder is a working example of this setup, with the
dashboard on top.

## Data model

| Table           | Holds                                                   |
| --------------- | ------------------------------------------------------- |
| `workflows`     | One row per version of a workflow                       |
| `steps`         | The steps in each workflow version                      |
| `workflow_runs` | One row each time a workflow is started                 |
| `step_runs`     | Progress of each step in a run; workers claim from here |
| `events`        | Append-only history of every state change               |

The full definition is in
[`workflowEngine/src/stores/postgres/schema.sql`](workflowEngine/src/stores/postgres/schema.sql). TypeScript types
are generated from the live database with `kysely-codegen`, so after changing
the schema run `pnpm db:reset` and then `pnpm db:types`.
