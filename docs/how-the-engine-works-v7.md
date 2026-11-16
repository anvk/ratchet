# How the engine works (v7)

Here's the whole engine from the ground up, using one example throughout: the fake **payment** workflow.

---

## 1. The big idea

A **workflow** is a set of **steps**, where some steps need others to finish first:

```
                                    ┌→ score-risk ───────┐
receive-payment → validate-account ─┤                    ├→ post-ledger
                                    └→ screen-sanctions ─┘
```

The risk and sanctions checks don't need each other, so they run at the same time, and `post-ledger` waits for both. Running this by hand would be easy: call the functions, two of them at once. The hard part is everything that can go wrong in real life:

- The process crashes halfway. Which steps already happened?
- You run 3 worker processes for speed. How do you stop two of them doing the same step?
- Two steps finish at the same moment on two workers. Who starts the step that needs both, and how do you make sure it starts exactly once?
- A worker freezes, or its machine disappears, in the middle of a step. Who finishes that step, and how does anyone notice?
- A step fails because a service hiccuped. Should it try again, and how soon?
- A retry repeats a write that already happened. What stops a double charge?
- A step fails for a real reason. What happens to the rest, including a step running alongside it?
- Two payments from the same account run at the same time. How do you stop both passing the balance check before either has posted?
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
    { name: "score-risk", needs: ["validate-account"], leaseMs: 10_000, run: ... },
    { name: "screen-sanctions", needs: ["validate-account"], maxAttempts: 4, backoffMs: 500, run: ... },
    { name: "post-ledger", needs: ["score-risk", "screen-sanctions"], run: ... },
  ],
});
```

Each step is just an async function. It gets a `ctx` (the "context"):

- `ctx.input`: what the run was started with, such as `{ forceOutcome: "clear" }`;
- `ctx.outputs`: the results of the steps it depends on, which is how step 2 knows the amount from step 1;
- `ctx.attempt`: 1 the first time, higher if the step had to run again, after an error (section 11) or because its worker went silent (section 8);
- `ctx.signal`: fires if this worker loses the step to another one (section 8), or if the attempt runs past its time limit (section 11);
- `ctx.idempotencyKey`: a stable id for this step (more in section 12).

Whatever the function returns becomes its **output**. If it throws, the attempt **fails**, and the step is retried (section 11). To fail for good straight away, throw a **`NonRetryableError`**.

**`needs`** lists the steps that must succeed before this one starts (section 10). Leave it out and a step needs the one listed before it, so a plain list still runs in order: that's why `receive-payment` and `validate-account` don't set it. A step can only need steps listed **before** it. That one rule catches typos (a name that isn't a step), a step needing itself, and loops (two steps each waiting for the other), and `defineWorkflow` throws if it's broken.

`ctx.outputs` holds every step a step depends on, directly or through others: `post-ledger` needs the two checks, but it can also read `receive-payment`'s amount, because it depends on that through them. What it never holds is a step running alongside. `score-risk` can't see `screen-sanctions`' output, because whether that exists yet would depend on which finished first.

A step can also set **`leaseMs`**: how long its worker may go silent before the step is given to someone else (section 7). `score-risk` sets 10 seconds; steps that don't set one get the engine's default of 30 seconds.

And it can set its **retry policy** (section 11): **`maxAttempts`**, how many times it may run in all, and **`backoffMs`**, the first wait before a retry. `screen-sanctions` calls a flaky vendor, so it gets 4 attempts, starting half a second apart; steps that don't set them get 3 attempts, starting 1 second apart.

And a **time limit**: **`timeoutMs`**, how long one attempt may run before the worker gives up on it (section 11). `screen-sanctions` sets 6 seconds. Steps that don't set one have no limit.

The workflow as a whole can set **`concurrency`**: runs that share a key, such as payments from one account, don't overlap (section 13).

The engine knows nothing about payments. It only knows "named functions and what each one needs".

---

## 3. Two kinds of tables: the recipe and the cooking

The schema (`workflowEngine/src/stores/postgres/schema.sql`) has two groups of tables. The best analogy is a recipe versus cooking that recipe tonight:

|                                       | Table           | Holds                                                                                                                                                              |
| ------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **The plan** (the recipe)             | `workflows`     | One row per version of a workflow                                                                                                                                  |
|                                       | `steps`         | The steps in each version, with each step's `needs`, `lease_ms`, `max_attempts` and `backoff_ms`                                                                   |
|                                       | `schedules`     | One row per schedule: a workflow to start, when, and with what input (section 16)                                                                                  |
| **The execution** (tonight's cooking) | `workflow_runs` | One row each time someone starts a workflow, with its concurrency group and when it was admitted (section 13)                                                      |
|                                       | `step_runs`     | Progress of each step in that run, with its `needs` copied from the plan: **this is the to-do list workers pick from**. A running step also has `lease_expires_at` |
|                                       | `events`        | A diary of everything that happened, never edited                                                                                                                  |

On startup, the API calls `engine.sync()`, which copies each workflow's plan into `workflows` and `steps`. The orchestrator's process calls it too before it starts its loop, because it starts runs as well (section 16). If you edit a workflow, say by renaming a step or changing what it needs, its lease or its retries, it gets a **new version row**. Old runs keep pointing at the version they started with, so the dashboard still shows them correctly.

**Workers only claim runs of a version they have.** During a deploy, old and new workers run side by side. Without this, an old worker could pick up a step of a run started on the new version, and run it with old code against a new plan. Each worker knows the versions of its own workflows, and the claim query (section 6) only matches those, so old workers finish old runs and new workers take new ones.

---

## 4. Starting a run

Something calls `startRun`, for example when you press **Start run** in the dashboard. In **one database transaction**, the store:

1. inserts a `workflow_runs` row with status **`queued`**;
2. inserts one `step_runs` row per step:
   - steps that need nothing are **`ready`** (claimable now); in the payment workflow that's only `receive-payment`, but a workflow can have several starting steps;
   - the others are **`pending`** (waiting for what they need);
3. writes events: `run_queued`, and `step_ready` for each ready step.

```
workflow_runs:  [run A: queued]
step_runs:      receive-payment: READY
                validate-account: pending
                score-risk:       pending
                ...
```

Nobody has run anything yet. The run is just waiting in the database.

**Why one transaction?** Either all of it is saved or none of it is. You can never end up with a run that has no steps, or steps with no run.

A run in a concurrency group whose group is full starts differently: every step is `pending`, and the run waits for a slot (section 13).

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
- **`ready_at <= now()`** skips steps waiting out a retry's backoff (section 11).

The real query also joins the run's workflow and keeps only versions this worker has (section 3).

So worker 1 gets step A, worker 2 skips A and gets step B, worker 3 gets C, all at the same moment with no waiting. Then, still in that transaction, the worker marks the step **`running`**, records its `worker_id`, bumps its `attempt`, and gives it a **lease**: `lease_expires_at` = now + the step's `leaseMs`.

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

The orchestrator (`workflows/orchestrator.ts`) is a separate process running a loop. It has two jobs: this section's, and starting scheduled runs (section 16). Every second (`sweepIntervalMs`) it **sweeps**: it looks for `running` steps whose lease has expired, makes each one **`ready`** again, clears its worker, and writes a `step_lease_expired` event. The next worker that asks claims it as **attempt 2**.

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

**A worker freezes:** JavaScript runs one thing at a time, and heartbeats are timers. A step doing heavy calculation, like `score-risk`'s simulation, blocks its worker, so **no heartbeat can run until the calculation ends**. From outside, busy and dead look the same. Suppose the first attempt of `score-risk` blocks for about 18 seconds, past its 10-second lease.

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

1. locks the run's row (section 10 explains why);
2. checks that this worker still owns the step (same worker, same attempt), and rejects the result if not;
3. saves the output, marks the step **`succeeded`** and clears its lease;
4. marks **`ready`** every step that needs this one and whose other needs have all succeeded too;
5. or, if every step has now succeeded, marks the run **`succeeded`**;
6. writes events (`step_succeeded`, `step_ready`, …).

**❌ It threw an error:** `failStep`, in one transaction, with the same run lock and ownership check. If the error can be retried and the step has attempts left, it's scheduled to run again (section 11). Otherwise it fails for good:

1. saves the error message and marks the step **`failed`**, with a **failure reason** (section 11);
2. marks **`skipped`** every step that depends on it, directly or through others, because none of them can ever run;
3. leaves every other step alone: steps already running finish, and steps whose needs are met still start;
4. once nothing in the run can move any more, marks the run **`failed`**, with the reason of the step that failed first.

Here's a payment run where the sanctions check finds a match:

```
receive-payment   ✅ succeeded
validate-account  ✅ succeeded
screen-sanctions  ❌ failed: "Sanctions list match"     at 2s
post-ledger       – skipped (needs screen-sanctions)    at 2s
score-risk        ✅ succeeded, still running alongside at 3.5s → the run fails now
```

A sanctions match is a decision, not a glitch: asking again gives the same answer. So the step throws a `NonRetryableError` and doesn't retry.

**Why let `score-risk` finish?** Runs only move forward: a run does all the work it still can. `post-ledger` needs sanctions, so it can never run, and it's skipped straight away. `score-risk` doesn't need sanctions, so by the workflow's own description it's still valid work, and stopping it would throw that work away. If a step mustn't happen when another fails, it should `need` that step. Finishing what can be finished also pays off with redrive (section 11): steps that succeeded are never run again, so the more that succeeded, the less a resume has to redo. The cost is a slower answer: the run says `failed` only when the last running step ends.

**Why does every change write an event in the same transaction?** The `events` table is the run's diary, which is the event list on the run page. Because the diary entry and the state change are saved together, the diary can never disagree with the current state.

---

## 10. Steps side by side, and the join

When `validate-account` finishes, two steps need only it: `score-risk` and `screen-sanctions`. Both become `ready` in the same transaction, and two workers claim them, one each. The run now has two steps running at once.

**The join is the hard part.** `post-ledger` needs both checks. Suppose they finish at the same moment, on two workers, and each runs `completeStep`:

```
worker-1: score-risk done.        Is screen-sanctions done? No, still running.  → do nothing
worker-2: screen-sanctions done.  Is score-risk done?       No, still running.  → do nothing
```

Both are telling the truth. Each transaction can't see the other's change until it commits, so each sees the other step as still running. Neither readies `post-ledger`, and the run is **stuck forever**, with every step either finished or waiting.

**The fix: one at a time, per run.** Every transaction that changes a started run's steps first locks that run's row in `workflow_runs` (`SELECT … FOR UPDATE`). Two steps of the same run finishing at once now take turns:

```
worker-1: lock run A. score-risk done. screen-sanctions? running. → nothing. Commit, unlock.
worker-2: (waits for the lock) lock run A. screen-sanctions done.
          score-risk? succeeded (worker-1 committed). → post-ledger is ready.
```

Whoever goes second sees the first one's work, so the step that needs both is readied **exactly once**. The lock only covers one run, so different runs never wait for each other, and it lasts milliseconds.

The same lock covers the other run-wide decision: "nothing can move any more, so the run is finished". Two branches ending at the same moment would otherwise each see the other still running, and the run would never be marked done. It also has to be taken in the same order everywhere, the run first and then its steps (with a concurrency group's lock in between, section 13), or two transactions could each hold the lock the other wants and wait forever (a **deadlock**). That's why the orchestrator's sweep locks the run before the expired step, too. (The one exception is claiming a run's very first step, which marks the run `running` while already holding the step. That claim never waits for the run's lock; section 14 explains why it mustn't.)

**Sticky claiming with branches:** when a worker's step readies two steps at once, the worker keeps the first and leaves the other for someone else (section 17).

---

## 11. Retries: trying again after an error

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

While it waits, the step is `ready` with `ready_at` in the future, so no worker can claim it yet (section 6). The dashboard shows it as **Retrying**.

**Not every error should be retried.** "Insufficient funds" or "Sanctions list match" won't change if you ask again. A step throws a **`NonRetryableError`** for those, and the run fails at once. The payment workflow turns every decline from the payment service into one.

**Every step has a limit.** After `maxAttempts` (3 unless the step sets its own), the step fails for good and the run fails with it (section 9). Errors and lost leases both use up attempts.

**A step can be stuck without failing.** Everything above starts with a step that throws. A vendor that never answers doesn't throw: the step just waits. Its worker is fine, so heartbeats keep going and the lease keeps renewing (section 7). A lease only proves the **worker** is alive, not that the **step** is getting anywhere. Left alone, the step would run forever, and in a concurrency group it would keep its run's slot forever too (section 13).

So a step can set **`timeoutMs`**, a limit on one attempt. When it passes, the worker fires `ctx.signal`, stops waiting for the step, and records the attempt as failed with the error `Timed out after 6000ms`. From there it's an ordinary failed attempt: it waits out its backoff and runs again, and it counts towards `maxAttempts`. Here is a sanctions check whose vendor doesn't answer the first time:

```
0.0s   attempt 1 claimed     the vendor never answers
6.0s   the time limit passes → ctx.signal fires, step_retry_scheduled ("Timed out after 6000ms")
6.5s   attempt 2 claimed     the vendor answers → step_succeeded
```

The worker enforces the limit with a timer of its own; the orchestrator isn't involved and nothing about it is stored. That leaves two cases a timer in the worker can't catch, and the lease already covers both: a worker that died has no timers, and a worker whose event loop is blocked can't run them, but neither can send heartbeats either (section 8).

As with a lost lease, the signal is only a request. If the step's function ignores it, it carries on in the background, and whatever it returns or throws later is thrown away. Its retry may then run while it's still going, which is one more reason for steps with side effects to be safe to repeat (section 12). The limit isn't part of the workflow's version (section 3), so changing it doesn't strand any runs.

**A failure says why.** Every failure is final, so the status is just `failed`. The `failure_reason` column on the step and the run says why, and that tells you what to do about it:

| `failure_reason`     | What happened                                          | What to do                                                   |
| -------------------- | ------------------------------------------------------ | ------------------------------------------------------------ |
| `non_retryable`      | The step threw a `NonRetryableError`                   | Nothing to fix: it was a decision                            |
| `attempts_exhausted` | It kept throwing until it ran out of attempts          | Fix the cause (a vendor outage, a bug), then start a new run |
| `lost_worker`        | It kept losing its worker until it ran out of attempts | Find what kills or stalls the worker                         |
| `unknown_step`       | No worker had code for the step                        | Deploy workers that have it                                  |
| `cancelled`          | The step was running when its run was cancelled        | Nothing: see section 14                                      |

The dashboard shows the reason next to the Failed badge.

**Resuming a failed run (redrive).** Once you've fixed the cause, you don't have to start again from the beginning. `redriveRun` (the **Resume run** button on the run page) puts the run back to `running`: every step that didn't succeed goes back to `pending`, those whose needs have already succeeded become `ready`, and steps that succeeded keep their outputs and never run again. It's offered for every reason except `non_retryable`, where asking again won't change a decision, and for a run that was cancelled (section 14).

The resumed steps get **fresh attempts**, but their attempt numbers keep counting up: attempt 5, not attempt 1. The ownership check (section 8) matches on the attempt number, so if it started again from 1, a worker that lost its lease before the run failed, and is somehow still running, could match a new attempt and save a stale result. Instead, `prior_attempts` remembers where the redrive happened, and `maxAttempts` counts only the attempts after it.

---

## 12. Idempotency keys: protecting against duplicates

Leases and retries both mean a step can run **more than once**: in the freeze example, worker-3 really did compute the risk score, and its work was thrown away. If a step does something with side effects and then fails, or its worker crashes before saving, the next attempt does it again. So steps run **at least once**, and any step with side effects must be safe to repeat.

"Idempotent" means "doing it twice has the same effect as doing it once". There are two kinds of keys:

- **Run key (chosen by the caller):** start a run with `idempotency_key: "order-123"` twice, and the second call starts nothing and returns the first run's id. This protects against a double click or a retried HTTP request.
- **Step key (provided by the engine):** `ctx.idempotencyKey` is always `runId:stepName`, the same on every attempt. A step passes it to outside services, such as a payment provider, so if the step ever runs again, the provider can say "I've already seen this one" instead of charging twice.

In the freeze example, running `score-risk` twice was harmless because it only calculates. `post-ledger` is different: it writes money movements.

**The double charge.** Suppose `post-ledger`'s first attempt writes the debit and credit, then its reply times out, so the step throws. From the worker's side, it can't tell the write worked. The engine does the right thing and retries, and attempt 2 writes the ledger **again**:

```
debit  957.76     ← attempt 1
credit 957.76
debit  957.76     ← attempt 2: the customer is charged twice
credit 957.76
```

The run even shows **Passed**. Nothing looks wrong.

**The fix belongs in the step, not the engine.** The engine can't know whether a write landed when the reply was lost; only the ledger can recognise a repeat. So the ledger has a unique key on `(payment_id, direction)`, and posting uses `ON CONFLICT DO NOTHING`. The second post finds the entries already there and changes nothing: one debit, one credit, however many attempts it takes. That's what "idempotent" means in practice, and it's the general rule: **the engine retries; each step makes its own side effects safe to repeat.**

---

## 13. Concurrency groups: runs that must not overlap

Everything so far keeps **one run** correct. Some bugs only appear when **two runs** overlap. In a real payment system, take an account holding $100 and two payments of $80 from it, started a second apart:

```
0.0s  payment A  validate-account   balance 100: enough
1.0s  payment B  validate-account   balance 100: enough   ← A hasn't posted yet
2.0s  payment A  post-ledger        balance 20
3.0s  payment B  post-ledger        balance -60
```

Each run did everything right. The run lock (section 10) can't help, because it only covers one run. Idempotency keys (section 12) can't either: they stop the same thing happening twice, not two different things happening at once. The two runs simply mustn't overlap.

(The demo's balances are simulated, so it never actually goes below zero.)

**Declaring a group.** A workflow can say which runs must not overlap:

```ts
defineWorkflow({
  name: "payment",
  concurrency: { key: (input) => (input.account ? `account:${input.account}` : null), limit: 1 },
  steps: [...],
});
```

The **key** is worked out from the run's input when it starts. Runs with the same key form a **group**, and at most **`limit`** runs of a group are in progress at once; the rest wait. Payments from different accounts have different keys, so they never wait for each other. A key of `null` means the run is in no group at all, which is why demo payments without an `account` aren't limited. The limit isn't part of the workflow's version (section 3), so changing it doesn't strand anything.

**Waiting and admission.** A run is **in progress** from when it's **admitted** (given a slot) until it finishes, whether it succeeded, failed or was cancelled. `workflow_runs` records three things for this: the run's `concurrency_key`, its `concurrency_limit`, and `admitted_at`.

- **Starting a run:** if its group has a free slot, it's admitted at once and starts like any other run, with an extra `run_admitted` event. If the group is full, it's saved with **every step `pending`** and no `admitted_at`, and writes `run_waiting`. It stays `queued`.
- **While it waits:** it has no `ready` step, so no worker can claim anything from it. The claim query (section 6) didn't change at all.
- **When a run in the group finishes:** in the same transaction, its slot goes to the **oldest waiting run**, which gets `admitted_at`, writes `run_admitted`, and has its first steps readied.

```
0s     A starts   group "account:acct_shared" has a free slot → admitted, receive-payment ready
0.2s   B starts   the group is full                          → run_waiting, every step pending
0.4s   C starts   the group is full                          → run_waiting
8s     A finishes                                            → B admitted (the oldest waiting)
16s    B finishes                                            → C admitted
```

**Slots are counted, never stored.** There's no "2 of 3 used" counter anywhere. Each time, the store counts the runs with that key that are admitted and not finished. A counter can drift: a bug in one path, or a crash between taking a slot and giving it back, and a slot leaks and blocks the group forever. A count can't leak, because a finished run simply stops being counted.

**The same race, one level up.** "Count the slots, then admit a run" is check-then-act, the same shape as the join (section 10). Two runs starting at the same moment would each count zero, each admit itself, and the limit would be broken. The fix is the same too: **one at a time, per group.** Before counting, a transaction takes a lock for the key:

```sql
SELECT pg_advisory_xact_lock(hashtextextended('account:acct_shared', 0));
```

An **advisory lock** locks a number instead of a row, so a group needs no row of its own; the key is hashed into the number. The `xact` means it's released when the transaction ends, like the row locks. Whoever goes second waits, then counts the first one's run too.

It fits into the lock order from section 10: **run, then group, then steps.** Finishing a run already holds that run's lock, then takes its group's. Starting a run holds no run lock yet, because the run is new. And the only runs locked while the group lock is held are waiting ones. Just one other thing can hold a waiting run, a cancel, so admission skips a waiting run that's locked instead of waiting for it (section 14).

**Redrive goes through admission too.** A run that failed or was cancelled gave its slot back. Redriving it (section 11) puts it back in line: it's `queued` again, admitted at once if there's a free slot, and otherwise it waits like a new run. Without that, redrive would be a way around the limit. It keeps its original start time, so it goes ahead of runs that started waiting after it.

---

## 14. Cancelling a run

Sometimes you want a run to stop: it was started by mistake, or it's stuck and holding its group's slot (section 13). `cancelRun` (the **Cancel run** button on the run page) stops any run that hasn't finished, in one transaction:

- steps that haven't started, `pending` or `ready`, become `skipped`;
- a step that's `running` becomes `failed`, with the reason `cancelled`;
- the run becomes **`cancelled`**, and its slot goes to the next waiting run.

```
receive-payment   ✅ succeeded
validate-account  ✅ succeeded
score-risk        ❌ failed: "Run cancelled"   (it was running)
screen-sanctions  ❌ failed: "Run cancelled"   (it was running)
post-ledger       – skipped
run               cancelled
```

**Cancelled is its own status, not a kind of failure.** Nothing went wrong: someone decided. If a cancelled run were `failed`, it would sit in the Failed tab and be counted with the failures, and anyone watching for failures would be alerted by every run a colleague stopped on purpose. So a run can end three ways, `succeeded`, `failed` or `cancelled`, and the dashboard has a tab and a count for each. A cancelled run has no `failure_reason`; only the steps that were cut off do.

Steps have no `cancelled` status. A step that was running when its run was cancelled really didn't finish, so it's `failed`, and its reason, `cancelled`, says it wasn't the step's fault.

A cancelled run can be resumed like a failed one: **Resume run** puts back the steps that didn't succeed, cut off or skipped, and the run carries on from there.

**How does the worker find out?** Nothing is sent to it. The cancelled step is no longer `running`, so the worker's next heartbeat finds nothing to renew (section 7). That is exactly what a lost lease looks like: `ctx.signal` fires, and if the step finishes anyway, its result matches nothing and is rejected (section 8). The run is over the moment you cancel; the worker hears within a third of the step's lease.

**Cancelling has a deadlock to avoid.** Everything that changes a run's steps locks the run first (section 10), and so does a cancel. But a cancel is the first thing that locks a run **before it has started**, and a run's first claim takes its locks the other way round, the step and then the run:

```
worker:  claim receive-payment          holds the step, now needs the run
cancel:  lock the run                   holds the run, now needs the step
         → each waits for the other
```

The worker needs the run for two things, and each got its own fix:

- **Marking the run `running`.** The claim only does that if the run's row is free (`SKIP LOCKED`, the trick from section 6). If a cancel holds it, the run is about to be over anyway.
- **Writing its events.** An event row points at its run, and Postgres briefly locks the run to make sure it isn't deleted meanwhile. A cancel therefore takes a slightly weaker lock on the run, `FOR NO KEY UPDATE`: it still makes every other change to the run's steps wait, but it lets rows that merely point at the run through.

The cancel then waits for the worker's claim to commit, and fails the step it just claimed. It can do that because it changes all the steps in **one statement** that decides row by row. Two statements, "skip what hasn't started" and then "fail what's running", could miss a step claimed between them, and leave it running in a finished run.

Cancelling a run that is **waiting for a slot** had the same problem with the group lock: the cancel holds the run and wants the group, while a run finishing in that group holds the group and wants the waiting run, to admit it. So admission (section 13) picks and locks its candidate in one query and passes over one that's locked. A locked waiting run is one being cancelled, and the next in line should get the slot anyway.

These are the deadlocks that were found. Section 15 covers what happens if there is one that wasn't.

---

## 15. Deadlocks: when two transactions wait for each other

A **deadlock** is two transactions that each hold something the other needs:

```
cancel:  holds the run,   wants the step
worker:  holds the step,  wants the run
```

Neither can move, and neither is doing anything wrong. They arrived in the same few milliseconds, in an unlucky order.

**The engine avoids them with one lock order.** A deadlock needs a circle of waiting. If every transaction takes its locks in the same order, there can't be one, because nobody ever holds a later lock while waiting for an earlier one. The engine's order is **run, then group, then steps** (sections 10 and 13), with a schedule's row before all of them (section 16). The few places that can't follow it never wait instead: a run's first claim and the admission of a waiting run both skip a row that's locked (section 14).

**Is a deadlock expected?** It isn't expected, but it isn't impossible. The lock order rules out every deadlock that is known about, so in normal running there are none. What it can't rule out is a mistake. The order is kept by care, not enforced by anything: one piece of code that takes two locks the other way round creates a deadlock, and it only shows when two transactions meet at the wrong moment.

**If one happens, Postgres breaks it.** Postgres never lets a deadlock hang. After a second of waiting it looks for a circle, and if it finds one it aborts one of the transactions with the error `deadlock detected`, undoes everything that transaction did, and lets the other carry on. Nothing is left half done: the aborted transaction's changes and its events are all gone together.

**The engine does not try again by itself.** The error goes to whoever asked:

- **A worker** logs it, waits a second (`errorBackoffMs`) and goes back to its loop. If it was claiming a step, the step is still there to claim. If it was saving a step's result, the result is lost, the step's lease runs out, and the step runs again (section 8).
- **A call such as `cancelRun` or `startRun`** fails, and the caller sees the error. Calling it again works.

**Why not retry it automatically?** A retry would usually succeed: by the time the aborted transaction ran again, the other one would have finished. But a deadlock means the lock order has a hole, and a retry would turn that into a line in a log that nobody reads. A failed operation gets noticed, and then the hole gets found and closed. The cost is small, because nothing is lost or left inconsistent, so the engine prefers the mistake to be visible.

---

## 16. Schedules: starting runs by the clock

A run can start because something calls `startRun`, or because the clock says it's time. For the second you create a **schedule**:

```ts
await engine.schedules.create({
  workflow: "greeting",
  name: "every-minute",
  cron: "* * * * *",
  input: { name: "the scheduler" },
});
```

A schedule belongs to a workflow and has a **name**, the **input** its runs start with, and a time. A workflow can have any number of them, each with its own input.

**It repeats, or it fires once.** A repeating schedule has a **cron expression**. It's the usual five fields, minute, hour, day of month, month and day of week, read in **UTC**: `0 2 * * *` is two o'clock every night, `*/15 * * * *` every quarter of an hour, `0 9 * * 1-5` nine o'clock on weekdays. Each field takes `*`, a number, a range (`1-5`), a step (`*/15`) or a list of those. An expression that can't be read, or one that never comes round, such as the 31st of February, is rejected.

One rule of cron surprises people. When both day fields are set, a day matches if **either** does: `0 0 13 * 5` is every Friday and every 13th, not only a Friday the 13th.

A one-time schedule has a moment, `at`, in place of the expression:

```ts
await engine.schedules.create({
  workflow: "greeting",
  name: "launch-day",
  at: new Date("2027-03-01T09:00:00Z"),
  input: { name: "everyone" },
});
```

It starts one run at that moment and never another. Its row stays afterwards, with nothing left to fire, so you can see that it ran. A moment that has already passed is rejected: to start a run now, call `startRun`. A schedule keeps its kind, so turning one into the other means deleting it and creating it again.

**A schedule is a row, not part of the workflow.** A step's `needs` belong in the code, because the code is what they describe. When a workflow runs, and with what input, is something you want to change while everything is running: add a report for a new customer, hold one back during an incident. So a schedule lives in the `schedules` table and nowhere else, and it is created and changed through the engine:

| Call                      | What it does                                          | Returns `false` when                                            |
| ------------------------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| `engine.schedules.create` | Saves a schedule, due at its next tick or at its `at` | the workflow already has a schedule with that name              |
| `engine.schedules.update` | Changes the cron, the `at` or the input               | there's no such schedule, or it's a one-time one that has fired |
| `engine.schedules.pause`  | Stops it firing                                       | there's no such schedule, or it's already paused                |
| `engine.schedules.resume` | Lets it fire again                                    | there's no such schedule, or it isn't paused                    |
| `engine.schedules.delete` | Removes it. The runs it started stay, and keep its id | there's no such schedule                                        |

`false` means the call didn't apply and nothing changed, as with `cancelRun`. A request that could never be right throws instead: a workflow the engine doesn't have, a cron that can't be read, both a `cron` and an `at`.

Because it's a row, a schedule survives restarts and `engine.sync()`, which only saves plans (section 3). It also means a new database has no schedules until something creates them. Creating the same schedule at every startup is safe: the second time, the name is taken and the call returns `false`.

A schedule belongs to a workflow by name, not to one version of it. Its runs start on whichever version the orchestrator that fires it has.

**Changing one.** A new cron takes effect from now: the next run is at the new expression's first tick after the change. Changing only the input leaves the next tick where it was, and the next run starts with the new input.

**Pausing.** A paused schedule starts nothing. When a repeating schedule is resumed, it carries on from the first tick after that moment, and the ticks that passed while it was paused start no runs: pausing it meant those runs weren't wanted. A one-time schedule has only one tick, so if its moment passed while it was paused, it fires when it's resumed.

**Who starts the run?** The orchestrator (section 8). Each row holds the time it's next due, `next_fire_at`. On each of its rounds, a second apart, the orchestrator looks for rows that are due and not paused, among the schedules of the workflows it has, and starts a run for each. A schedule of a workflow it doesn't have is left alone: it may belong to another engine using the same database.

**The hard part is two orchestrators.** Running more than one is allowed, and it's what happens for a moment in every deploy. If each one looks at the clock, sees that it's two o'clock and starts the nightly run, the workflow runs twice:

```
orchestrator-1: is "nightly" due? yes → start a run
orchestrator-2: is "nightly" due? yes → start a run      ← a second run for the same night
```

This is the claiming problem from section 6 again, with a schedule in place of a step, and the same trick settles it. Firing a schedule is **one transaction**:

```sql
SELECT ... FROM schedules
WHERE next_fire_at <= now() AND paused_at IS NULL
ORDER BY next_fire_at
LIMIT 1
FOR UPDATE SKIP LOCKED;
```

1. lock a due schedule's row, skipping any row that's locked;
2. insert the run with the row's input, exactly as `startRun` would (section 4);
3. move the row's `next_fire_at` on to the schedule's next tick, or clear it for a one-time schedule.

```
orchestrator-1: locks "nightly". Starts the run. Sets next_fire_at to tomorrow. Commits.
orchestrator-2: "nightly" is locked → skips it. Looks again a second later: it isn't due any more.
```

Because the run and the new `next_fire_at` are saved together, there's no moment at which the run exists but the schedule still looks due, or the schedule has moved on but the run was never created.

An update or a resume locks the same row, so an edit and a firing take turns: the firing skips a row that's being edited and finds it again on its next round.

**The store asks the engine about the run.** A schedule's input is only known once its row is read, and the store has rows but not your code. So the engine hands `fireDueSchedules` a function, `scheduledRunFor`: given a due schedule's workflow and input, it returns the workflow's definition and the concurrency group that input falls in (section 13). If your `key` function throws for a schedule's input, that round of firing fails with the error, and fails again every round until the schedule's input is fixed or the schedule is deleted. Schedules are fired in the order they came due, so the ones due after it wait as well.

**A second line that fails out loud.** Every run a schedule starts records which schedule it was and which tick it was for (`schedule_id` and `scheduled_for`), and the database refuses two runs with the same pair. The lock is what keeps a schedule from firing twice. The rule in the database is there so that a mistake in the locking shows up as an error instead of as a workflow that quietly ran twice. It's also why schedules don't use a run idempotency key (section 12): a repeated key returns the first run without complaint, which would hide exactly this mistake.

`schedule_id` is a plain id, not a foreign key. With a foreign key, deleting a schedule would have to update every run it ever started, and so lock them. Without one, every schedule operation touches the schedule's row and nothing else.

**Missed ticks start one run.** If no orchestrator was running for three hours, an every-minute schedule has missed 180 ticks. Starting 180 runs at once would help nobody. The first orchestrator back starts **one** run, for the oldest tick that was missed, and sets `next_fire_at` to the first tick after now. A one-time schedule whose moment was missed this way fires when an orchestrator is back. This is different from pausing, which starts no run for the ticks it skipped: nobody chose for the orchestrator to be down.

**A scheduled run is an ordinary run.** It's created by the same code as any other, so it waits its turn in a concurrency group (section 13), can be cancelled (section 14) and writes the same events. The only differences are the two columns above, and its `run_queued` event, which names the schedule.

That also answers what happens when a run takes longer than the gap between ticks: the next tick starts another run alongside it. A workflow that mustn't overlap with itself says so with `concurrency`, and its scheduled runs then queue like any others.

**Where the lock fits.** When a schedule fires, its row is locked before anything else, and the run is then started under it in the usual way (section 13). Nothing that holds a run or a group ever needs a schedule, so this lock can't be part of a circle (section 15).

---

## 17. Claim order: which step a worker picks next

When several steps are ready, which one does a worker take? That's the `claimOrder` setting (`workflows/engine.ts`):

- **`sticky` (default):** when a worker finishes a step, it takes the **next step of the same run** right away, inside the same transaction, with a fresh lease. So a run goes start to finish on one worker, apart from branches: if two steps become ready at once, it keeps the first and another worker takes the other. With 3 workers and 10 runs: about 3 run at a time, each finishing quickly.
- **`fair`:** take whichever step has waited longest. Runs take turns, so all 10 start and move forward together.
- **`oldest-run-first`:** take a step from the oldest run, on any worker.

Every step is still saved separately, with its own lease, in all three modes. `sticky` is only a preference, so if the worker dies, any other worker can continue the run. A step put back by the orchestrator joins the queue like any other ready step.

---

## 18. Shutting down gracefully

When you press Ctrl+C on a worker (`closeOnSignals`):

- **First Ctrl+C:** the worker stops claiming new steps but **finishes the step it's on**, then exits. Nothing is cut off mid-way.
- **If that takes longer than `closeTimeoutMs`** (30s), it gives up waiting and exits anyway.
- **Second Ctrl+C:** exits immediately (forced).

In the last two cases the step it abandoned keeps its lease until the lease runs out, then the orchestrator gives it to another worker. A deploy never loses a step.

---

## 19. The store interface: why Postgres is swappable

The engine never writes SQL itself. It only talks to a `WorkflowStore` interface (`workflowEngine.types.ts`):

```ts
interface WorkflowStore {
  syncWorkflows(...)  startRun(...)
  claimStep(...)      completeStep(...)   failStep(...)
  extendLease(...)    sweepExpiredLeases()
  redriveRun(...)     cancelRun(...)
  createSchedule(...) updateSchedule(...) deleteSchedule(...)
  setSchedulePaused(...)                  fireDueSchedules(...)
  close()
}
```

`createPostgresStore()` is one implementation of it. You could write a file-based or SQLite store with the same fifteen methods, and the engine and workers wouldn't change.

`failStep` decides between a retry and a final failure in one transaction, using the step's retry policy from the plan. The run lock (section 10) and the group lock (section 13) are the store's business too: the interface only promises that two steps finishing at once ready a step that needs both exactly once, and that a group never has more than its limit in progress, and each store keeps those promises its own way. Leases are part of the same interface on purpose: the ownership check has to happen in the same transaction that saves a step's result, so leases must live wherever step state lives.

---

## 20. The whole picture

```
 Dashboard ──HTTP──▶ API ──startRun──▶ ┌────────────────── Postgres ─────────────────┐
    ▲                 │                │ schedules  workflow_runs  step_runs  events │
    └─────reads───────┘                └─────────────────────────────────────────────┘
                                          ▲  claim / heartbeat /     ▲ sweep expired leases,
                                          │  complete / fail         │ start scheduled runs
                               ┌──────────┼──────────┐               │
                           worker-1   worker-2   worker-3      orchestrator
```

1. The **API** starts runs (through the engine, which admits them or makes them wait) and reads tables for the dashboard.
2. **Workers** claim ready steps of versions they have, run your functions while sending heartbeats, save the results, and ready the steps that were waiting on them.
3. The **orchestrator** gives steps whose worker went silent to another worker, and starts a run each time a schedule is due.
4. **Postgres** holds everything, so any process can die and restart without losing progress.

---

## What it doesn't handle yet

- **A retry repeats whatever the failed attempt already did,** unless the step makes it safe to repeat (section 12). The engine can't do that for you.
- **A failed run takes as long as its slowest independent step.** Steps that don't depend on the failed one finish first, so the caller hears "failed" later than it could.
- **A version covers the plan, not the code.** Changing a step's name, needs, lease or retries makes a new version; changing only the code inside `run` doesn't, so old and new workers both claim the same runs.
- **Lost leases need the orchestrator:** if it isn't running, steps whose worker went silent stay `running`.
- **A run that never finishes keeps its slot.** A run whose steps no worker can claim, say because no worker has its version, stays in progress, and every run waiting behind it in its group waits too, until someone cancels it.
- **A timed-out step isn't stopped.** The worker stops waiting for it, but unless the step honours `ctx.signal` its function keeps running in the background, and may overlap with its own retry.
- **A step without a time limit can hang forever.** If it never returns and its worker stays alive, nothing gives up on it.
- **A cancelled step isn't stopped either.** Its worker hears at its next heartbeat, up to a third of the lease later, and the step's function only stops if it honours `ctx.signal`.
- **Schedules need the orchestrator too.** While none is running, nothing fires; when one starts again, each schedule that missed ticks starts one run, not one for each.
- **A schedule doesn't wait for its last run.** Each tick starts a run even if the one before is still going, unless the workflow's `concurrency` makes them take turns.

All ten are listed in `workflowEngine/guarantees.md`.
