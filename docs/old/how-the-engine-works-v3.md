# How the engine works (v3)

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
- A worker freezes, or its machine disappears, in the middle of a step. Who finishes that step, and how does anyone notice?
- A step fails because a service hiccuped. Should it try again, and how soon?
- A retry repeats a write that already happened. What stops a double charge?
- A step fails for a real reason. What happens to the rest?
- You need to deploy. How do you stop without cutting a step off mid-way?

The engine's answer is simple: **keep all progress in the database, not in memory.** Workers are disposable. They read "what needs doing next" from Postgres, do it, and write the result back. If a worker dies, the progress it already saved is still there, and the step it was in the middle of goes to another worker. If a step fails, only that step runs again.

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
    { name: "score-risk", leaseMs: 10_000, run: (ctx) => scoreRisk(...) },
    { name: "screen-sanctions", maxAttempts: 4, backoffMs: 500, run: (ctx) => screenSanctions(...) },
    ...
  ],
});
```

Each step is just an async function. It gets a `ctx` (the "context"):
- `ctx.input`: what the run was started with, such as `{ forceOutcome: "clear" }`;
- `ctx.outputs`: the results of earlier steps, which is how step 2 knows the amount from step 1;
- `ctx.attempt`: 1 the first time, higher if the step had to run again, after an error (section 10) or because its worker went silent (section 8);
- `ctx.signal`: fires if this worker loses the step to another one (section 8);
- `ctx.idempotencyKey`: a stable id for this step (more in section 11).

Whatever the function returns becomes its **output**. If it throws, the attempt **fails**, and the step is retried (section 10). To fail for good straight away, throw a **`NonRetryableError`**.

A step can also set **`leaseMs`**: how long its worker may go silent before the step is given to someone else (section 7). `score-risk` sets 10 seconds; steps that don't set one get the engine's default of 30 seconds.

And it can set its **retry policy** (section 10): **`maxAttempts`**, how many times it may run in all, and **`backoffMs`**, the first wait before a retry. `screen-sanctions` calls a flaky vendor, so it gets 4 attempts, starting half a second apart; steps that don't set them get 3 attempts, starting 1 second apart.

The engine knows nothing about payments. It only knows "a list of named functions". That's why adding a workflow is just one new file plus one line in `workflows/index.ts`.

---

## 3. Two kinds of tables: the recipe and the cooking

The schema (`workflowEngine/src/stores/postgres/schema.sql`) has two groups of tables. The best analogy is a recipe versus cooking that recipe tonight:

| | Table | Holds |
|---|---|---|
| **The plan** (the recipe) | `workflows` | One row per version of a workflow |
| | `steps` | The steps in each version, in order, with each step's `lease_ms`, `max_attempts` and `backoff_ms` |
| **The execution** (tonight's cooking) | `workflow_runs` | One row each time someone starts a workflow |
| | `step_runs` | Progress of each step in that run: **this is the to-do list workers pick from**. A running step also has `lease_expires_at` |
| | `events` | A diary of everything that happened, never edited |

On startup, the API calls `engine.sync()`, which copies each workflow's plan into `workflows` and `steps`. If you edit a workflow, say by renaming a step or changing its lease or retries, it gets a **new version row**. Old runs keep pointing at the version they started with, so the dashboard still shows them correctly.

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
  claim a ready step from the database (it comes with a lease)
  if there was one → run it, renewing the lease every so often, save the result
  if not           → sleep 250ms (pollMs), try again
```

`pnpm dev` starts **3 workers**, each a separate process, plus **1 orchestrator** (section 8). They never talk to each other. The database is the only thing they share.

---

## 6. Claiming: how two workers never grab the same step

This is the most important trick in the engine. Imagine all 3 workers asking at the same instant, "give me a ready step". Without care, all three could pick `receive-payment` of run A and charge the customer three times.

The claim query (`claimStep` in `postgres.store.ts`) looks roughly like this:

```sql
SELECT id FROM step_runs
WHERE status = 'ready' AND ready_at <= now()
ORDER BY ready_at
LIMIT 1
FOR UPDATE SKIP LOCKED;
```

- **`FOR UPDATE`** locks the row it finds: "I'm taking this one".
- **`SKIP LOCKED`** tells the other workers: "if a row is locked, don't wait for it, just take the next one".
- **`ready_at <= now()`** skips steps waiting out a retry's backoff (section 10).

So worker 1 gets step A, worker 2 skips A and gets step B, worker 3 gets C, all at the same moment with no waiting. Then, still in that transaction, the worker marks the step **`running`**, records its `worker_id`, bumps its `attempt`, and gives it a **lease**: `lease_expires_at` = now + the step's `leaseMs`.

One test (`engine.test.ts`) starts 40 runs with 6 workers and checks that every step was claimed exactly once. When I removed `SKIP LOCKED` as an experiment, that test failed. That's how we know the lock is doing the work.

The lock only lasts for that claim's transaction, a few milliseconds. From then on, what says "this step belongs to worker 2" is the lease.

---

## 7. Leases and heartbeats: owning a step for a limited time

Think of a library book. You can keep it until its due date, and renew it as often as you like. If you stop renewing (you moved away, you forgot), the library eventually treats it as returned and lends it to someone else.

A lease works the same way for a step:

- **The loan:** claiming a step sets `lease_expires_at`. Until then, the step is this worker's.
- **Renewing:** while the step runs, the worker sends a **heartbeat** every third of the lease (`store.extendLease`): "still alive, give me another `leaseMs`". A heartbeat only works if the step is still `running` with this worker's id and attempt, in other words if the worker still owns it.
- **The due date passing:** if heartbeats stop, the lease runs out. Nothing happens to the worker; it's the **orchestrator** that notices (section 8).

**Why leases?** A database lock can't be held for the minutes a step might run, and a crashed process can't tell anyone it crashed. Silence is the only signal a dead worker gives. A lease turns that silence into something the database can check: an expiry time in the past.

---

## 8. The orchestrator: when a worker goes silent

The orchestrator (`workflows/orchestrator.ts`) is a separate process running a loop. Every second (`sweepIntervalMs`) it **sweeps**: it looks for `running` steps whose lease has expired, makes each one **`ready`** again, clears its worker, and writes a `step_lease_expired` event. The next worker that asks claims it as **attempt 2**.

**A worker crashes:**

```
0s    worker-2 claims score-risk         attempt 1, lease until 10s
3s    worker-2's machine dies            no more heartbeats
10s   the lease expires
≤11s  the orchestrator sweeps it         step_lease_expired, step_ready
11s   worker-1 claims it                 attempt 2, with a fresh lease
14s   worker-1 completes it              the payment carries on
```

Nobody had to notice the crash. The silence was enough.

**Lost leases count as attempts.** If a step crashes its worker every time (it runs out of memory, say), each lost lease uses up an attempt. When none are left, the orchestrator fails the step instead (`Lost its worker on attempt 3 of 3`), and the run ends like any other failure (section 9). Without that limit, it would keep killing workers forever.

**A worker freezes:** JavaScript runs one thing at a time, and heartbeats are timers. A step doing heavy calculation, like `score-risk`'s simulation, blocks its worker, so **no heartbeat can run until the calculation ends**. From outside, busy and dead look the same. Try the **Risk check overloads its worker** preset: the first attempt of `score-risk` blocks for about 18 seconds, past its 10-second lease.

```
0s    worker-3 claims score-risk and starts an 18-second calculation
10s   the lease expires: worker-3 is busy, not dead, but can't say so
≤11s  the orchestrator sweeps it; worker-1 claims attempt 2, done in ~3s
18s   worker-3 finishes and tries to save its result → rejected
```

Why rejected? Saving a result uses the same ownership check as a heartbeat: the step must be `running`, for this worker, on this attempt. By then it's on attempt 2, so worker-3's write matches nothing. Its next heartbeat fails too, which fires `ctx.signal`, the step's cue to stop early if it can. JavaScript can't force a function to stop, so the signal is only a request; the rejected write is the guarantee.

That's why `score-risk` sets `leaseMs: 10_000`: a normal risk check blocks for 3 to 4.5 seconds, so 10 seconds leaves room for that while still recovering a stuck one quickly.

---

## 9. Finishing a step

The worker calls the step's `run` function, renewing its lease while it runs. Then one of two things happens.

**✅ It returned a value:** `completeStep`, in one transaction:
1. checks that this worker still owns the step (same worker, same attempt), and rejects the result if not;
2. saves the output, marks the step **`succeeded`** and clears its lease;
3. marks the next step **`ready`**;
4. or, if that was the last step, marks the run **`succeeded`**;
5. writes events (`step_succeeded`, `step_ready`, …).

**❌ It threw an error:** `failStep`, in one transaction, with the same ownership check. If the error can be retried and the step has attempts left, it's scheduled to run again (section 10). Otherwise it fails for good:
1. saves the error message and marks the step **`failed`**, with a **failure reason** (below);
2. marks all remaining steps **`skipped`**;
3. marks the run **`failed`**, with the same reason.

Here's the payment run with the "Sanctions match" preset, as you've seen in the dashboard:

```
receive-payment   ✅ succeeded
validate-account  ✅ succeeded
score-risk        ✅ succeeded
screen-sanctions  ❌ failed: "Sanctions list match"
post-ledger       – skipped
```

A sanctions match is a decision, not a glitch: asking again gives the same answer. So the step throws a `NonRetryableError`, and the run fails at once instead of trying three times.

**Why does every change write an event in the same transaction?** The `events` table is the run's diary, which is the event list on the run page. Because the diary entry and the state change are saved together, the diary can never disagree with the current state.

---

## 10. Retries: trying again after an error

Most failures in real systems are temporary: a timeout, a dropped connection, a service restarting. Giving up on the whole payment because a vendor was slow for a second would be silly. So when a step throws, the engine **runs that step again**, and only that step.

**Only the failed step runs again, never the whole workflow.** Every finished step is a checkpoint: its output is saved, and later steps read it from `ctx.outputs`. Retrying the failed step is resuming from the last checkpoint. Starting the run over would redo steps that already worked, side effects and all.

**A retry waits first.** Hammering a struggling service makes it worse, so each retry waits longer than the last (**exponential backoff**): `backoffMs`, then double, then double again, up to `maxBackoffMs` (30 seconds). Each wait is also nudged by up to 20% either way (**jitter**), so a hundred steps that failed at the same moment don't all retry at the same moment too.

```
0.0s   attempt 1 claimed     the vendor times out
       → step_retry_scheduled, ready_at = now + ~0.5s
0.5s   attempt 2 claimed     the vendor times out again
       → step_retry_scheduled, ready_at = now + ~1s
1.5s   attempt 3 claimed     the vendor answers → step_succeeded
```

While it waits, the step is `ready` with `ready_at` in the future, so no worker can claim it yet (section 6). The dashboard shows it as **Retrying**. Try the **Flaky sanctions vendor** preset to watch it happen.

**Not every error should be retried.** "Insufficient funds" or "Sanctions list match" won't change if you ask again. A step throws a **`NonRetryableError`** for those, and the run fails at once. The payment workflow turns every decline from the payment service into one.

**Every step has a limit.** After `maxAttempts` (3 unless the step sets its own), the step fails for good and the run fails with it (section 9). Errors and lost leases both use up attempts. Try the **Sanctions vendor down** preset: the vendor times out on all 4 attempts.

**A failure says why.** Every failure is final, so the status is just `failed`. The `failure_reason` column on the step and the run says why, and that tells you what to do about it:

| `failure_reason` | What happened | What to do |
|---|---|---|
| `non_retryable` | The step threw a `NonRetryableError` | Nothing to fix: it was a decision |
| `attempts_exhausted` | It kept throwing until it ran out of attempts | Fix the cause (a vendor outage, a bug), then start a new run |
| `lost_worker` | It kept losing its worker until it ran out of attempts | Find what kills or stalls the worker |
| `unknown_step` | No worker had code for the step | Deploy workers that have it |

The dashboard shows the reason next to the Failed badge.

---

## 11. Idempotency keys: protecting against duplicates

Leases and retries both mean a step can run **more than once**: in the freeze example, worker-3 really did compute the risk score, and its work was thrown away. If a step does something with side effects and then fails, or its worker crashes before saving, the next attempt does it again. So steps run **at least once**, and any step with side effects must be safe to repeat.

"Idempotent" means "doing it twice has the same effect as doing it once". There are two kinds of keys:

- **Run key (chosen by the caller):** start a run with `idempotency_key: "order-123"` twice, and the second call starts nothing and returns the first run's id. This protects against a double click or a retried HTTP request.
- **Step key (provided by the engine):** `ctx.idempotencyKey` is always `runId:stepName`, the same on every attempt. A step passes it to outside services, such as a payment provider, so if the step ever runs again, the provider can say "I've already seen this one" instead of charging twice.

In the freeze example, running `score-risk` twice was harmless because it only calculates. `post-ledger` is different: it writes money movements.

**The double charge.** Try the **Ledger write times out** preset. `post-ledger`'s first attempt writes the debit and credit, then its reply "times out", so the step throws. From the worker's side, it can't tell the write worked. The engine does the right thing and retries, and attempt 2 writes the ledger **again**:

```
debit  957.76     ← attempt 1
credit 957.76
debit  957.76     ← attempt 2: the customer is charged twice
credit 957.76
```

The run even shows **Passed**. Nothing looks wrong.

**The fix belongs in the step, not the engine.** The engine can't know whether a write landed when the reply was lost; only the ledger can recognise a repeat. So the ledger has a unique key on `(payment_id, direction)`, and posting uses `ON CONFLICT DO NOTHING`. The second post finds the entries already there and changes nothing: one debit, one credit, however many attempts it takes. That's what "idempotent" means in practice, and it's the general rule: **the engine retries; each step makes its own side effects safe to repeat.**

---

## 12. Claim order: which step a worker picks next

When several steps are ready, which one does a worker take? That's the `claimOrder` setting (`workflows/engine.ts`):

- **`sticky` (default):** when a worker finishes a step, it takes the **next step of the same run** right away, inside the same transaction, with a fresh lease. So a run goes start to finish on one worker. With 3 workers and 10 runs: 3 run at a time, each finishing quickly.
- **`fair`:** take whichever step has waited longest. Runs take turns, so all 10 start and move forward together.
- **`oldest-run-first`:** take a step from the oldest run, on any worker.

Every step is still saved separately, with its own lease, in all three modes. `sticky` is only a preference, so if the worker dies, any other worker can continue the run. A step put back by the orchestrator joins the queue like any other ready step.

---

## 13. Shutting down gracefully

When you press Ctrl+C on a worker (`closeOnSignals`):

- **First Ctrl+C:** the worker stops claiming new steps but **finishes the step it's on**, then exits. Nothing is cut off mid-way.
- **If that takes longer than `closeTimeoutMs`** (30s), it gives up waiting and exits anyway.
- **Second Ctrl+C:** exits immediately (forced).

In the last two cases the step it abandoned keeps its lease until the lease runs out, then the orchestrator gives it to another worker. A deploy never loses a step.

---

## 14. The store interface: why Postgres is swappable

The engine never writes SQL itself. It only talks to a `WorkflowStore` interface (`workflowEngine.types.ts`):

```ts
interface WorkflowStore {
  syncWorkflows(...)  startRun(...)
  claimStep(...)      completeStep(...)   failStep(...)
  extendLease(...)    sweepExpiredLeases()
  close()
}
```

`createPostgresStore()` is one implementation of it. You could write a file-based or SQLite store with the same eight methods, and the engine and workers wouldn't change. The shutdown tests already do this with a fake in-memory store.

`failStep` decides between a retry and a final failure in one transaction, using the step's retry policy from the plan. Leases are part of the same interface on purpose: the ownership check has to happen in the same transaction that saves a step's result, so leases must live wherever step state lives.

---

## 15. The whole picture

```
 Dashboard ──HTTP──▶ API ──startRun──▶ ┌──────────── Postgres ────────────┐
    ▲                 │                │ workflow_runs  step_runs  events │
    └─────reads───────┘                └──────────────────────────────────┘
                                          ▲  claim / heartbeat /     ▲ sweep expired
                                          │  complete / fail         │ leases
                               ┌──────────┼──────────┐               │
                           worker-1   worker-2   worker-3      orchestrator
```

1. The **API** starts runs (through the engine) and reads tables for the dashboard.
2. **Workers** claim ready steps, run your functions while sending heartbeats, and save the results.
3. The **orchestrator** gives steps whose worker went silent to another worker.
4. **Postgres** holds everything, so any process can die and restart without losing progress.

---

## What it doesn't handle yet

- **A retry repeats whatever the failed attempt already did,** unless the step makes it safe to repeat (section 11). The engine can't do that for you.
- **A run that failed for good can't be resumed.** Once a step runs out of attempts, the run has to be started again from the beginning, even after you've fixed what broke.
- **Lost leases need the orchestrator:** if it isn't running, steps whose worker went silent stay `running`.

All three are listed in `workflowEngine/guarantees.md`.

---

**A good way to learn it:** read the files in this order:
1. `workflows/greeting/workflow.ts` (the simplest workflow);
2. `workflowEngine.worker.ts` (the loop, the heartbeats, and deciding whether an error can be retried);
3. `workflowEngine.orchestrator.ts` (the sweep);
4. `claimStep`, `completeStep`, `failStep`, `extendLease` and `sweepExpiredLeases` in `postgres.store.ts` (the database side).

Keep the dashboard open while you start a run, and you can watch each part of this happen live in the event list. Four presets show the rest:
- **Risk check overloads its worker:** a lease expires and another worker takes over;
- **Flaky sanctions vendor:** a step fails twice, waits, and succeeds on attempt 3;
- **Sanctions vendor down:** a step fails on every attempt, and the run fails as "Out of attempts";
- **Ledger write times out:** the retry that would charge twice, and the unique key that stops it.
