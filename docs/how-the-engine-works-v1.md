# How the engine works (v1)

Here's the whole engine from the ground up, using one example throughout: the fake **payment** workflow.

---

## 1. The big idea

A **workflow** is a list of **steps** that must happen in order:

```
receive-payment → validate-account → score-risk → screen-sanctions → post-ledger
```

Running this by hand would be easy: call five functions in a row. The hard part is everything that can go wrong in real life:

- The process crashes halfway. Which steps already happened?
- You run 3 worker processes for speed. How do you stop two of them doing the same step?
- A step fails. What happens to the rest?
- You need to deploy. How do you stop without cutting a step off mid-way?

The engine's answer is simple: **keep all progress in the database, not in memory.** Workers are disposable. They read "what needs doing next" from Postgres, do it, and write the result back. If a worker dies, the progress it already saved is still there.

---

## 2. Writing a workflow (the "recipe")

You describe a workflow with `defineWorkflow` (`workflows/payment/workflow.ts`):

```ts
defineWorkflow({
  name: "payment",
  steps: [
    { name: "receive-payment", run: (ctx) => receivePayment(...) },
    { name: "validate-account", run: (ctx) => validateAccount({
        amountCents: ctx.outputs["receive-payment"].amountCents, ... }) },
    ...
  ],
});
```

Each step is just an async function. It gets a `ctx` (the "context"):
- `ctx.input`: what the run was started with, such as `{ forceOutcome: "clear" }`;
- `ctx.outputs`: the results of earlier steps, which is how step 2 knows the amount from step 1;
- `ctx.idempotencyKey`: a stable id for this step (more in section 8).

Whatever the function returns becomes its **output**. If it throws, the step **fails**.

The engine knows nothing about payments. It only knows "a list of named functions". That's why adding a workflow is just one new file plus one line in `workflows/index.ts`.

---

## 3. Two kinds of tables: the recipe and the cooking

The schema (`workflowEngine/src/stores/postgres/schema.sql`) has two groups of tables. The best analogy is a recipe versus cooking that recipe tonight:

| | Table | Holds |
|---|---|---|
| **The plan** (the recipe) | `workflows` | One row per version of a workflow |
| | `steps` | The steps in each version, in order |
| **The execution** (tonight's cooking) | `workflow_runs` | One row each time someone starts a workflow |
| | `step_runs` | Progress of each step in that run: **this is the to-do list workers pick from** |
| | `events` | A diary of everything that happened, never edited |

On startup, the API calls `engine.sync()`, which copies each workflow's plan into `workflows` and `steps`. If you edit a workflow, say by renaming a step, it gets a **new version row**. Old runs keep pointing at the version they started with, so the dashboard still shows them correctly.

---

## 4. Starting a run

Something calls `startRun`, for example when you press **Start run** in the dashboard. In **one database transaction**, the store:

1. inserts a `workflow_runs` row with status **`queued`**;
2. inserts one `step_runs` row per step:
   - the first step is **`ready`** (claimable now);
   - the others are **`pending`** (not yet);
3. writes events: `run_queued`, `step_ready`.

```
workflow_runs:  [run A: queued]
step_runs:      receive-payment: READY
                validate-account: pending
                score-risk:       pending
                ...
```

Nobody has run anything yet. The run is just waiting in the database.

**Why one transaction?** Either all of it is saved or none of it is. You can never end up with a run that has no steps, or steps with no run.

---

## 5. Workers: the loop that does the work

A worker (`workflowEngine.worker.ts`) is a loop that runs forever:

```
loop:
  claim a ready step from the database
  if there was one → run it, save the result
  if not           → sleep 250ms (pollMs), try again
```

`pnpm dev` starts **3 workers**, each a separate process. They never talk to each other. The database is the only thing they share.

---

## 6. Claiming: how two workers never grab the same step

This is the most important trick in the engine. Imagine all 3 workers asking at the same instant, "give me a ready step". Without care, all three could pick `receive-payment` of run A and charge the customer three times.

The claim query (`claimStep` in `postgres.store.ts`) looks roughly like this:

```sql
SELECT id FROM step_runs
WHERE status = 'ready'
ORDER BY ready_at
LIMIT 1
FOR UPDATE SKIP LOCKED;
```

- **`FOR UPDATE`** locks the row it finds: "I'm taking this one".
- **`SKIP LOCKED`** tells the other workers: "if a row is locked, don't wait for it, just take the next one".

So worker 1 gets step A, worker 2 skips A and gets step B, worker 3 gets C, all at the same moment with no waiting. Then, still in that transaction, the worker marks the step **`running`** and records its `worker_id`.

One test (`engine.test.ts`) starts 40 runs with 6 workers and checks that every step was claimed exactly once. When I removed `SKIP LOCKED` as an experiment, that test failed. That's how we know the lock is doing the work.

---

## 7. Finishing a step

The worker calls the step's `run` function. Then one of two things happens.

**✅ It returned a value:** `completeStep`, in one transaction:
1. saves the output and marks the step **`succeeded`**;
2. marks the next step **`ready`**;
3. or, if that was the last step, marks the run **`succeeded`**;
4. writes events (`step_succeeded`, `step_ready`, …).

**❌ It threw an error:** `failStep`, in one transaction:
1. saves the error message and marks the step **`failed`**;
2. marks all remaining steps **`skipped`**;
3. marks the run **`failed`**.

Here's the payment run with the "Sanctions match" preset, as you've seen in the dashboard:

```
receive-payment   ✅ succeeded
validate-account  ✅ succeeded
score-risk        ✅ succeeded
screen-sanctions  ❌ failed: "Sanctions list match"
post-ledger       – skipped
```

**Why does every change write an event in the same transaction?** The `events` table is the run's diary, which is the event list on the run page. Because the diary entry and the state change are saved together, the diary can never disagree with the current state.

---

## 8. Claim order: which step a worker picks next

When several steps are ready, which one does a worker take? That's the `claimOrder` setting (`workflows/engine.ts`):

- **`sticky` (default):** when a worker finishes a step, it takes the **next step of the same run** right away, inside the same transaction. So a run goes start to finish on one worker. With 3 workers and 10 runs: 3 run at a time, each finishing quickly.
- **`fair`:** take whichever step has waited longest. Runs take turns, so all 10 start and move forward together.
- **`oldest-run-first`:** take a step from the oldest run, on any worker.

Every step is still saved separately in all three modes. `sticky` is only a preference, so if the worker dies, any other worker can continue the run.

---

## 9. Idempotency keys: protecting against duplicates

"Idempotent" means "doing it twice has the same effect as doing it once". There are two kinds of keys:

- **Run key (chosen by the caller):** start a run with `idempotency_key: "order-123"` twice, and the second call starts nothing and returns the first run's id. This protects against a double click or a retried HTTP request.
- **Step key (provided by the engine):** `ctx.idempotencyKey` is always `runId:stepName`. A step passes it to outside services, such as a payment provider, so if the step ever runs again, the provider can say "I've already seen this one" instead of charging twice.

---

## 10. Shutting down gracefully

When you press Ctrl+C on a worker (`closeOnSignals`):

- **First Ctrl+C:** the worker stops claiming new steps but **finishes the step it's on**, then exits. Nothing is cut off mid-way.
- **If that takes longer than `closeTimeoutMs`** (30s), it gives up waiting and exits anyway.
- **Second Ctrl+C:** exits immediately (forced).

---

## 11. The store interface: why Postgres is swappable

The engine never writes SQL itself. It only talks to a `WorkflowStore` interface (`workflowEngine.types.ts`):

```ts
interface WorkflowStore {
  syncWorkflows(...)  startRun(...)
  claimStep(...)      completeStep(...)   failStep(...)
  close()
}
```

`createPostgresStore()` is one implementation of it. You could write a file-based or SQLite store with the same six methods, and the engine and workers wouldn't change. The shutdown tests already do this with a fake in-memory store.

---

## 12. The whole picture

```
 Dashboard ──HTTP──▶ API ──startRun──▶ ┌──────────── Postgres ────────────┐
    ▲                 │                │ workflow_runs  step_runs  events │
    └─────reads───────┘                └──────────────────────────────────┘
                                          ▲   claim / complete / fail
                               ┌──────────┼──────────┐
                           worker-1   worker-2   worker-3
```

1. The **API** starts runs (through the engine) and reads tables for the dashboard.
2. **Workers** claim ready steps, run your functions, and save the results.
3. **Postgres** holds everything, so any process can die and restart without losing progress.

---

## What it doesn't handle yet

- **A worker killed mid-step** (for example `kill -9`) leaves that step `running` forever. Nothing notices the worker is gone.
- **No retries:** one temporary failure fails the whole run.

Both are known gaps, listed in `workflowEngine/guarantees.md`.

---

**A good way to learn it:** read the files in this order:
1. `workflows/greeting/workflow.ts` (the simplest workflow);
2. `workflowEngine.worker.ts` (the loop);
3. `claimStep` and `completeStep` in `postgres.store.ts` (the database side).

Keep the dashboard open while you start a run, and you can watch each part of this happen live in the event list.