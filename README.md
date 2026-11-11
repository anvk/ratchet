# ratchet

## Run it

You need Node 22 or newer, pnpm 12 and a Docker runtime such as OrbStack.

```sh
cp .env.example .env
pnpm install
pnpm dev
```

Open <http://localhost:5173>, pick a workflow and press **Start run**. `pnpm dev` starts Postgres, the API, the orchestrator, three workers and the dashboard.
How it all works is explained in [`docs/how-the-engine-works-v3.md`](docs/how-the-engine-works-v3.md)
(earlier designs: [v1](docs/how-the-engine-works-v1.md), [v2](docs/how-the-engine-works-v2.md)).

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
| `workflows/`      | Workflow definitions, the list of them, and the process entry points: `api.ts`, `worker.ts` and `orchestrator.ts`                                                                                                                         |
| `client/`         | Dashboard: runs list and live diagram, driven only by the HTTP API                                                                                                                                                                        |
| `docs/`           | Walkthroughs of how the engine works, for newcomers: `how-the-engine-works-v3.md` describes the current engine; `v1` (the original design) and `v2` (with leases) show how it got there                                                   |

## Add a workflow

Create `workflows/<name>/workflow.ts`:

```ts
import { defineWorkflow } from "@ratchet/engine";

export default defineWorkflow<{ ticker: string }>({
  name: "stock-report",
  title: "Stock report",
  description: "Builds a short report on a stock.",
  presets: [{ label: "Apple", input: { ticker: "AAPL" } }],
  steps: [
    {
      name: "fetch-prices",
      title: "Fetch prices",
      description: "Loads recent prices.",
      async run(ctx) {
        return { ticker: ctx.input.ticker, prices: [] };
      },
    },
  ],
});
```

Then add it to the list in `workflows/index.ts`. The API copies its plan into
the database on startup, and the dashboard shows it with no other changes.

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
