# ratchet

## Run the demo

You need Node 22 or newer, pnpm 12 and a Docker runtime such as OrbStack.

```sh
cp .env.example .env
pnpm install
pnpm dev
```

`pnpm dev` starts the demo: Postgres, the API, the orchestrator, three workers
and the dashboard. Open the demo's dashboard at <http://localhost:5173>, pick
a workflow and press **Start run**.

How the engine works is explained in
[`docs/how-the-engine-works.md`](docs/how-the-engine-works.md).

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

The engine is one package. Everything in `demo/` is built on it, to show it
running; none of it is needed to use the engine.

**The engine**

| Path              | What's there                                                                                                                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflowEngine/` | Workers, the orchestrator, leases, retries, concurrency groups, schedules, the registry, the `WorkflowStore` interface, with Postgres in `src/stores/postgres/`, and the `MessageBroker` interface, with Postgres in `src/messageBrokers/postgres/`. What it promises is in `guarantees.md` |
| `docs/`           | `how-the-engine-works.md`, a walkthrough of how the engine works, for newcomers. `old/` holds walkthroughs of earlier designs                                                                                                                                                               |

**Demo only**

| Path              | What's there                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| `demo/workflows/` | Fake payment and greeting workflows, and the processes that run them (`api.ts`, `worker.ts`, `orchestrator.ts`) |
| `demo/api/`       | HTTP API for the dashboard. Reads the engine's tables directly and makes every change through the engine        |
| `demo/client/`    | The dashboard: runs list, live step diagram and event log, driven only by the HTTP API                          |

## Use the engine

### Define a workflow

A workflow is a list of named steps. Each step is an async function, and
`needs` says which steps must succeed before it starts. `version` is any text
you choose; change it when you change what a step's code does, so workers with
the old code and the new never share a run:

```ts
// stockReport.ts
import { defineWorkflow } from "@ratchet/engine";

export interface StockReportInput {
  ticker: string;
}

export default defineWorkflow<StockReportInput>({
  name: "stock-report",
  version: "1",
  steps: [
    {
      name: "fetch-prices",
      async run() {
        return { prices: [] };
      },
    },
    {
      name: "fetch-news",
      needs: [], // needs nothing, so it starts with fetch-prices
      async run() {
        return { headlines: [] };
      },
    },
    {
      name: "write-report",
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

### Create the engine

An engine pairs your workflows with a store, which keeps their state in
Postgres, and a message broker, which tells workers when there is work. Put it
in one module that every process imports, so they all agree on the workflows
and settings:

```ts
// engine.ts
import { createWorkflowEngine } from "@ratchet/engine";
import { createPostgresMessageBroker } from "@ratchet/engine/messageBrokers/postgres";
import { createPostgresStore } from "@ratchet/engine/postgres";
import stockReport from "./stockReport.ts";

export const engine = createWorkflowEngine({
  workflows: [stockReport],
  store: createPostgresStore(), // connects to DATABASE_URL
  messageBroker: createPostgresMessageBroker(), // LISTEN/NOTIFY on the same database
  settings: { timeoutMs: 60_000 }, // the rest are optional; see WorkflowEngineSettings
});
```

`timeoutMs` is how long one attempt of a step may run before the worker gives
up on it. It is the one setting without a default, so no step can hang forever
without someone having chosen its limit. A step can set its own `timeoutMs`.

### Run three kinds of process

They only share the database, so each can run as its own process, container
or pod.

**Whatever starts runs**, such as your API. `sync()` saves each workflow's
plan, which starting a run needs; call it once at startup. `startRun` only records
the run and returns its id. Workers do the work.

```ts
// api.ts
import { engine } from "./engine.ts";

await engine.sync();

const runId = await engine.startRun({ workflow: "stock-report", input: { ticker: "AAPL" } });
```

**Workers** claim ready steps and run them, until they're told to stop. Run
as many as you need; two never get the same step.

```ts
// worker.ts
import { closeOnSignals } from "@ratchet/engine";
import { engine } from "./engine.ts";

closeOnSignals(engine); // SIGTERM: stop claiming, finish running steps, then exit
await engine.runWorker();
await engine.close();
```

**One orchestrator**, which must be running: it is the only process that
recovers lost steps, fires schedules and relays messages to workers. It gives a step to another worker
when its worker stops sending heartbeats, for example because it crashed, and
starts a run each time a schedule is due. It starts runs, so it calls `sync()`
too.

```ts
// orchestrator.ts
import { closeOnSignals } from "@ratchet/engine";
import { engine } from "./engine.ts";

await engine.sync();

closeOnSignals(engine);
await engine.runOrchestrator();
await engine.close();
```

Workers don't call `sync()`.

### Messages, the outbox and the relay

A worker claims steps until there are none, then waits to be told there is
work. The message broker is what tells it.

```
store ──(same transaction)──▶ outbox ──(orchestrator's relay)──▶ message broker ──▶ workers
```

- The store saves a message in its `outbox` table in the same transaction as
  the change it is about: `step_ready` when a step becomes claimable
  (for a retry, held back until its backoff is over), `run_cancelled` when a
  run with a running step is cancelled.
- The orchestrator publishes what is waiting every `relayIntervalMs` (100ms)
  and deletes it once published. A broker that is down delays messages; it
  never loses them. A message can arrive twice.
- A worker that gets `step_ready` claims at once. One that gets
  `run_cancelled` for its run asks the store whether it still owns its step, and
  fires `ctx.signal` if not.

A message is only a hint: the store still decides who gets a step.

| Broker                                    | How workers hear about work                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `createPostgresMessageBroker()`           | Postgres `LISTEN`/`NOTIFY`, within about a tenth of a second. Nothing to run beside the database        |
| `createPollingMessageBroker({ everyMs })` | A timer: each worker asks the store every `everyMs` (250 by default). Carries nothing between processes |

Workers have no timer of their own. The Postgres broker also tells them to
look every 30 seconds whatever it has heard (`everyMs`), so a message that goes
missing makes a step late, not stuck; without an orchestrator to relay, that is
the only time they look. With the polling broker, workers need no orchestrator
to find work, and hear about a cancel at their next heartbeat.

To use another broker, implement `MessageBroker` (`publish`, `subscribe`,
`close`). It must tell its subscribers `step_ready` after any interruption in
which it could have missed a message, as the Postgres one does when it
reconnects.

### Keep some runs from overlapping

`concurrency` makes runs that share a key take turns. The key comes from the
run's input; at most `limit` runs with the same key are in progress at once,
and the rest wait, oldest first. A `null` key puts a run in no group:

```ts
export default defineWorkflow<StockReportInput>({
  name: "stock-report",
  version: "1",
  concurrency: { key: (input) => `ticker:${input.ticker}`, limit: 1 }, // one report per ticker at a time
  steps: [
    // ...as above
  ],
});
```

### Run it on a schedule

A schedule starts runs by the clock. It is a row in the database, created and
changed through the engine while everything is running. Each has a name, the
input its runs start with, and either a five-field cron expression in UTC or
one moment to fire at:

```ts
// Every night at 02:00 UTC.
await engine.schedules.create({
  workflow: "stock-report",
  name: "aapl-nightly",
  cron: "0 2 * * *",
  input: { ticker: "AAPL" },
});

// Once.
await engine.schedules.create({
  workflow: "stock-report",
  name: "launch-day",
  at: new Date("2027-03-01T09:00:00Z"),
  input: { ticker: "AAPL" },
});

await engine.schedules.update({
  workflow: "stock-report",
  name: "aapl-nightly",
  cron: "0 3 * * *",
});
await engine.schedules.pause({ workflow: "stock-report", name: "aapl-nightly" });
await engine.schedules.resume({ workflow: "stock-report", name: "aapl-nightly" });
await engine.schedules.delete({ workflow: "stock-report", name: "aapl-nightly" });
```

Each call returns `false` when it doesn't apply, such as creating a name the
workflow already has, so creating a schedule at every startup is safe. A
paused schedule skips its ticks. The orchestrator starts one run per tick,
however many orchestrators are running.

A schedule never has two of its runs going at once. A tick that comes due
while the run it last started hasn't finished starts nothing, and isn't made up
later: the schedule waits for its next tick, and the unfinished run gets a
`schedule_tick_skipped` event naming the tick. Only the schedule's own runs
count, not runs you start yourself or another schedule's. A run counts until it
has succeeded, failed or been cancelled, so a run waiting in a concurrency
group, or one you redrove, holds back the next tick too.

### Running in containers

- Build all three from one image and choose the entry file with the command,
  so every process runs the same code.
- Each worker needs a unique id. It defaults to `hostname-pid`, which is
  unique per pod in Kubernetes, or pass `runWorker({ workerId })`.
- Keep `closeTimeoutMs` below the time your platform waits between SIGTERM and
  killing the process (30 seconds in Kubernetes). A worker killed mid-step
  loses nothing: the orchestrator gives the step to another worker once its
  lease expires.
- A second orchestrator is safe: a lease is swept once and a schedule fires
  once, whichever of them gets there first.
- Each process keeps up to 10 Postgres connections for the store. The Postgres
  message broker adds one for publishing, in an orchestrator, and one for
  listening, in a worker. Keep processes × 11 under Postgres's
  `max_connections`.
- The listening connection must reach Postgres directly. A pooler that hands
  out connections per transaction, such as PgBouncer in transaction mode, can't
  deliver notifications.

The `demo/workflows/` folder is a working example of this setup, with the
dashboard on top.

## Data model

| Table           | Holds                                                                   |
| --------------- | ----------------------------------------------------------------------- |
| `workflows`     | One row per version of a workflow, with its `version`                   |
| `steps`         | The steps in each workflow version                                      |
| `schedules`     | One row per schedule, with when it next fires                           |
| `workflow_runs` | One row each time a workflow is started, with the version it started on |
| `step_runs`     | Progress of each step in a run; workers claim from here                 |
| `events`        | Append-only history of every state change                               |
| `outbox`        | Messages waiting to be published to the message broker                  |

The full definition is in
[`workflowEngine/src/stores/postgres/schema.sql`](workflowEngine/src/stores/postgres/schema.sql). TypeScript types
are generated from the live database with `kysely-codegen`, so after changing
the schema run `pnpm db:reset` and then `pnpm db:types`.

## License

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
