# ratchet

## Run it

You need Node 22 or newer, pnpm 12 and a Docker runtime such as OrbStack.

```sh
cp .env.example .env
pnpm install
pnpm dev
```

Open <http://localhost:5173>, pick a workflow and press **Start run**. `pnpm dev` starts Postgres, the API, the orchestrator, three workers and the dashboard.
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

| Path              | What's there                                                                                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflowEngine/` | The generic engine: workers, the orchestrator, leases, the registry and the `WorkflowStore` interface, with Postgres in `src/stores/postgres/`. Knows nothing about HTTP or any specific workflow. What it promises is in `guarantees.md` |
| `api/`            | HTTP API for clients. Reads tables directly, makes every state change through the engine, and exports its response types from `src/api.types.ts`                                                                                          |
| `workflows/`      | Workflow definitions, their dashboard presets, the list of them, and the process entry points: `api.ts`, `worker.ts` and `orchestrator.ts`                                                                                                |
| `client/`         | Dashboard: runs list and live diagram, driven only by the HTTP API                                                                                                                                                                        |
| `docs/`           | Walkthroughs of how the engine works, for newcomers: `how-the-engine-works-v4.md` describes the current engine; `v1` (the original design), `v2` (with leases) and `v3` (with retries) show how it got there                              |

## Add a workflow

Create `workflows/<name>/workflow.ts`:

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

A step without `needs` waits for the step listed before it, so a plain list
runs in order. A step can only need steps listed before it.

Then add it to the list in `workflows/index.ts`. The API copies its plan into
the database on startup, and the dashboard shows it with no other changes.

To offer ready-made inputs in the dashboard, add a `presets.ts` next to it and
list it in `presets` in `workflows/index.ts`. Presets are a dashboard feature;
the engine never sees them:

```ts
import type { Preset } from "@ratchet/api/types";
import type { StockReportInput } from "./workflow.ts";

export const presets: Preset<StockReportInput>[] = [{ label: "Apple", input: { ticker: "AAPL" } }];
```

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
