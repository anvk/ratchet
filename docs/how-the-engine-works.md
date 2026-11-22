# How the engine works

Here's the whole engine from the ground up, using one example throughout: the fake **payment** workflow.

---

## 1. The big idea

A **workflow** is a piece of code that asks for **steps**. A step is one piece of real work, such as a call to another service. Some steps come after others, and some run side by side:

```
                                    ┌→ score-risk ───────┐
receive-payment → validate-account ─┤                    ├→ post-ledger
                                    └→ screen-sanctions ─┘
```

The risk and sanctions checks don't need each other, so they run at the same time, and `post-ledger` waits for both. Running this by hand would be easy: call the functions, two of them at once. The hard part is everything that can go wrong in real life:

- The process crashes halfway. Which steps already happened?
- You run 3 worker processes for speed. How do you stop two of them doing the same step?
- Two steps finish at the same moment on two workers. Who starts the step that comes after both, and how do you make sure it starts exactly once?
- A worker freezes, or its machine disappears, in the middle of a step. Who finishes that step, and how does anyone notice?
- A step fails because a service hiccuped. Should it try again, and how soon?
- A retry repeats a write that already happened. What stops a double charge?
- A step fails for a real reason. What happens to the rest, including a step running alongside it?
- Two payments from the same account run at the same time. How do you stop both passing the balance check before either has posted?
- You need to deploy. How do you stop without cutting a step off mid-way?

The engine's answer is simple: **keep all progress in the database, not in memory.** Workers are disposable. Every step's result is saved the moment it finishes. To find out what a run should do next, a worker runs the workflow's code again from the top, handing it the results that are saved, and sees what it asks for. If a worker dies, nothing is lost but the step it was in the middle of, and that goes to another worker. If a step fails, only that step runs again.

---

## 2. Writing a workflow

You describe a workflow with `defineWorkflow` (`demo/workflows/payment/workflow.ts`). Here it is with the details trimmed:

```ts
defineWorkflow({
  name: "payment",
  version: "1",
  async run(ctx) {
    const payment = await ctx.step("receive-payment", () => receivePayment(ctx.input));
    await ctx.step("validate-account", () => validateAccount(payment));

    await Promise.all([
      ctx.step("score-risk", (step) => scoreRisk(step), { leaseMs: 10_000 }),
      ctx.step("screen-sanctions", (step) => screenSanctions(step), {
        maxAttempts: 4,
        backoffMs: 500,
        timeoutMs: 6_000,
      }),
    ]);

    return ctx.step("post-ledger", (step) => postLedger(payment, step.idempotencyKey));
  },
});
```

It reads like ordinary code, and that's the point. `await` one step, then the next. `Promise.all` asks for two at once. An `if` chooses between them, a loop asks for as many as the input says, and `try`/`catch` deals with one that failed. The engine has no separate way to say any of that.

**`ctx.step(name, fn, options)`** asks for a step and waits for its result.

- **`name`** identifies the step within the run. Each name is used once.
- **`fn`** is the work. It gets a small object describing this attempt:
  - `attempt`: 1 the first time, higher if the step had to run again, after an error (section 11) or because its worker went silent (section 8);
  - `abortSignal`: fires when the result won't be used: the step was taken away (section 8), ran past its time limit (section 11), or its run ended without it (sections 9 and 14);
  - `idempotencyKey`: a stable id for this step (section 12).
- **`options`** are settings for this one step:
  - **`leaseMs`**: how long its worker may go silent before the step is given to someone else (section 7). `score-risk` sets 10 seconds; the default is 30.
  - **`maxAttempts`** and **`backoffMs`**: how many times it may run in all, and the first wait before a retry (section 11). `screen-sanctions` calls a flaky vendor, so it gets 4 attempts, starting half a second apart; the defaults are 3 attempts, starting 1 second apart.
  - **`timeoutMs`**: how long one attempt may run before the worker gives up on it (section 11).

Whatever `fn` returns becomes the step's **output**, and that is what `await ctx.step(...)` gives the workflow: `payment` above is what `receive-payment` returned. If `fn` throws, the attempt **fails**, and the step is retried (section 11). To fail for good straight away, throw a **`NonRetryableError`**.

Whatever the workflow's function returns is the **run's output**. The workflow as a whole can also set **`concurrency`**: runs that share a key, such as payments from one account, don't overlap (section 13).

The engine knows nothing about payments. It only knows "code that asks for named steps".

---

## 3. What is saved

The schema (`workflowEngine/src/stores/postgres/schema.sql`) has six tables:

| Table           | Holds                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflows`     | One row per version of a workflow: its name and its `version`                                                                                   |
| `schedules`     | One row per schedule: a workflow to start, when, and with what input (section 15)                                                               |
| `workflow_runs` | One row each time someone starts a workflow, with its input, its output once it has one, and its concurrency group (section 13)                 |
| `step_runs`     | One row for each step a run has asked for, with its output: **this is the to-do list workers pick from**. A running step has `lease_expires_at` |
| `events`        | A diary of everything that happened, never edited                                                                                               |
| `outbox`        | Messages on their way to workers (section 19)                                                                                                   |

Notice what isn't there: a list of a workflow's steps. A workflow is code, and nothing knows which steps it will ask for until it runs. A run's steps appear in `step_runs` one by one, as its code asks for them.

**A run belongs to a version.** On startup, the API calls `engine.sync()`, which saves each workflow's name and `version`. The orchestrator's process calls it too before it starts its loop, because it starts runs as well (section 15). Every run points at the version it started on, and copies it into its own `workflow_version` column, so you can see it on the run without looking anything up.

**Workers only work on runs of a version they have.** During a deploy, old and new workers run side by side. Without this, an old worker could pick up a run started by new code, and run old code against results the new code saved. Each worker knows the versions of its own workflows and only touches runs of those, so old workers finish old runs and new workers take new ones.

**`version` is yours to change.** The engine can't see inside your code, so it can't tell when you've edited it. `version` is any text you choose, and changing it is the only thing that makes a new version. Change it when you edit a workflow in a way that runs already in progress couldn't carry on with: a step renamed, removed, or asked for in a different order. Leave it alone for a fix those runs should pick up.

---

## 4. Starting a run, and running the workflow's code

Something calls `startRun`, for example when you press **Start run** in the dashboard. In **one database transaction**, the store:

1. inserts a `workflow_runs` row with status **`queued`**, marked as needing its code run (`advance_at`);
2. writes a `run_queued` event, and a message telling workers there is something to do (section 19).

```
workflow_runs:  [run A: queued, needs advancing]
step_runs:      (nothing yet)
```

The run has no steps, because its code hasn't run. The process that called `startRun` never runs your workflow; a worker does.

**Advancing a run.** A worker picks up the marked run and runs its workflow function. The function gets as far as its first `ctx.step("receive-payment", ...)`. Nothing is saved for that step, so two things happen: the engine notes that the workflow asked for it, and the `await` doesn't finish. The function is stuck there, and that's fine. The worker's answer to "what does this run do next?" is **"it's waiting for `receive-payment`"**. So the store inserts a `step_runs` row for it, **`ready`** to be claimed, and the run becomes **`running`**.

That is the whole mechanism, and everything else builds on it. Each time something happens in a run, a worker runs the function **again from the top**, with whatever is saved by then:

```
nothing saved            → asks for receive-payment                    → make it ready
receive-payment saved    → gets its output, asks for validate-account  → make it ready
both saved               → asks for score-risk and screen-sanctions    → make both ready
...
all five saved           → the function returns                        → the run succeeded
```

A step whose result is saved **hands it back at once and doesn't run again**. So although the function starts from the top every time, it goes straight through the steps that are done, in a few microseconds, to the first thing it doesn't have. Running a workflow this way is called **replaying** it.

**How does the engine know the function is stuck?** Saved results are handed back as promises that have already finished, so the function moves through them without ever giving up its turn. The engine starts the function, lets the event loop turn once, and looks: by then the function has either finished, or it is waiting on a step with no result. It can't be anywhere else.

**The rules this puts on a workflow.** Replaying only works if the function does the same thing every time it is given the same results:

1. **Only `await` what `ctx` gives you.** A function waiting on its own timer or request looks stuck on nothing, and the run fails.
2. **Anything that can differ between two runs goes inside a step:** the clock, random numbers, a call to a service. A step's result is saved, so the function sees the same value every time.
3. **A step name is used once in a run.** In a loop, put the counter in the name.
4. **Change `version` when you change the path** (section 3).

Where the engine can tell a rule was broken, it fails the run and says so. If the function doesn't ask again for a step the run has saved, it has taken a different path from last time, and the run fails as **`nondeterministic`**. It never quietly carries on down the new path.

**Why one transaction, every time?** Either all of a change is saved or none of it is. You can never end up with a step that is ready but not recorded as asked for, or a run marked finished with a step still claimable.

A run in a concurrency group whose group is full isn't marked at all: its code doesn't run until it has a slot (section 13).

---

## 5. Workers: the loop that does the work

A worker (`workflowEngine.worker.ts`) is a loop that runs forever, with two jobs:

```
loop:
  is there a run marked as needing its code run?
    → run the workflow's function, save what it asked for        (advance, section 4)
  else, is there a ready step?
    → claim it (it comes with a lease), run it, save the result  (sections 6 to 9)
  else
    → wait to be told there is work, then look again
```

**Running a step means finding its code first.** A step's work is the function written inline in `ctx.step("score-risk", (step) => ...)`. It only exists while the workflow is running, and it uses values from earlier steps. So a worker that claims `score-risk` replays the workflow, with the results saved when it claimed, until the function asks for `score-risk`, and takes the function given there. Then it runs that, and only that. If the workflow never asks for the step, the code has changed under the run, and the step fails with `unknown_step`.

Who tells a waiting worker there is work is the **message broker** (section 19). The simplest one is a timer that says "look again" every 250ms, which is called **polling**. The demo uses one that speaks up only when there is something to find.

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

The orchestrator (`demo/workflows/orchestrator.ts`) is a separate process running a loop. It has three jobs: this section's, starting scheduled runs (section 15), and relaying messages to workers (section 19). Workers do neither, so an orchestrator has to be running: without one, a step whose worker went silent stays `running`, and no schedule fires. Every second (`sweepIntervalMs`) it **sweeps**: it looks for `running` steps whose lease has expired, makes each one **`ready`** again, clears its worker, and writes a `step_lease_expired` event. The next worker that asks claims it as **attempt 2**.

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

Why rejected? Saving a result uses the same ownership check as a heartbeat: the step must be `running`, for this worker, on this attempt. By then it's on attempt 2, so worker-3's write matches nothing. Its next heartbeat fails too, which fires the step's `abortSignal`, its cue to stop early if it can. JavaScript can't force a function to stop, so the signal is only a request; the rejected write is the guarantee.

That's why `score-risk` sets `leaseMs: 10_000`: a normal risk check blocks for 3 to 4.5 seconds, so 10 seconds leaves room for that while still recovering a stuck one quickly.

---

## 9. Finishing a step

The worker calls the step's function, renewing its lease while it runs. Then one of two things happens.

**✅ It returned a value:** `completeStep`, in one transaction:

1. locks the run's row (section 10 explains why);
2. checks that this worker still owns the step (same worker, same attempt), and rejects the result if not;
3. saves the output, marks the step **`succeeded`** and clears its lease;
4. **advances the run** (section 4): runs the workflow's function again, which now gets this step's output, and acts on what it does next;
5. writes events (`step_succeeded`, `step_ready`, …).

Step 4 has three possible outcomes:

- the function asks for more steps → each becomes **`ready`**;
- the function is still waiting on a step that hasn't finished → nothing to do;
- the function returns → the run is **`succeeded`**, with what it returned as its output.

The worker that finished the step does the advancing itself, in the same transaction. It has the workflow's code, and it already holds the run. So a run doesn't wait for anyone between one step and the next.

**❌ It threw an error:** `failStep`, in one transaction, with the same run lock and ownership check. If the error can be retried and the step has attempts left, it's scheduled to run again (section 11), and the workflow isn't told: as far as it knows, the step is still going. Otherwise the step fails for good:

1. saves the error message and marks the step **`failed`**, with a **failure reason** (section 11);
2. advances the run. This time, where the workflow is waiting for the step, the `await` **throws** a `StepFailedError`, carrying the step's name, reason and message.

What happens next is up to the workflow, as with any thrown error:

- **It doesn't catch it.** The function throws, so the run is **`failed`**, with the reason of the step that failed.
- **It catches it.** The function carries on. It might ask for a step that undoes earlier work, try something else, or return a result that says what happened. The run hasn't failed.

```ts
try {
  await ctx.step("book-hotel", bookHotel);
} catch (err) {
  await ctx.step("cancel-flight", cancelFlight); // undo what was done before
  return { booked: false };
}
```

**A run lasts exactly as long as its function.** The moment the function returns or throws, the run is over, and nothing is left running behind it:

- a step it asked for that hasn't started becomes **`skipped`**;
- a step that is still running is marked **`failed`** with the reason `cancelled`; its worker is told (section 19), and whatever it returns later is rejected.

Here's a payment run where the sanctions check finds a match:

```
receive-payment   ✅ succeeded
validate-account  ✅ succeeded
screen-sanctions  ❌ failed: "Sanctions list match"     at 2s
                  → the Promise.all throws, nothing catches it, the run fails   at 2s
score-risk        ❌ failed: stopped, it was still running                      at 2s
post-ledger       never asked for
```

A sanctions match is a decision, not a glitch: asking again gives the same answer. So the step throws a `NonRetryableError` and doesn't retry.

**Why stop `score-risk`?** Because nothing will ever read its result. The function has thrown; there is no line of code left to hand the risk score to. Letting it finish would be work, and possibly side effects, on behalf of a run that has already failed, and the caller would hear "failed" later for it. A workflow that wants the other check to finish says so, by catching the failure. `post-ledger` isn't skipped, either: it was never asked for, so there is no row for it at all.

**Why does every change write an event in the same transaction?** The `events` table is the run's diary, which is the event list on the run page. Because the diary entry and the state change are saved together, the diary can never disagree with the current state.

---

## 10. Steps side by side, and the step after both

When `validate-account` finishes and the run is advanced, the workflow reaches `Promise.all` and asks for `score-risk` and `screen-sanctions` in the same breath. Both become `ready` in the same transaction, and two workers claim them, one each. The run now has two steps running at once.

**The step after both is the hard part.** The workflow asks for `post-ledger` only once both checks are saved. Suppose they finish at the same moment, on two workers, and each one saves its result and advances the run:

```
worker-1: score-risk done.        Replay: screen-sanctions has no result.  → still waiting
worker-2: screen-sanctions done.  Replay: score-risk has no result.        → still waiting
```

Both are telling the truth. Each transaction can't see the other's change until it commits, so each replays the workflow without the other's result. Neither one's replay gets past the `Promise.all`, nobody asks for `post-ledger`, and the run is **stuck forever**, with every step finished.

**The fix: one at a time, per run.** A run is only ever advanced with its row in `workflow_runs` locked, and every transaction that changes a run's steps takes that lock first. Two steps of the same run finishing at once now take turns:

```
worker-1: lock run A. score-risk done. Replay: no result for screen-sanctions. → nothing. Commit, unlock.
worker-2: (waits for the lock) lock run A. screen-sanctions done.
          Replay: both saved (worker-1 committed). → the workflow asks for post-ledger.
```

Whoever goes second replays with both results, so the step after both is asked for **exactly once**. The lock only covers one run, so different runs never wait for each other, and it lasts milliseconds: a replay runs no steps and makes no calls, it only walks through saved results.

The lock has to be taken in the same order everywhere, the run first and then its steps (with a concurrency group's lock in between, section 13), or two transactions could each hold the lock the other wants and wait forever (a **deadlock**). That's why the orchestrator's sweep locks the run before the expired step, too. The one thing that takes a step before its run is a claim, and section 14 explains how that is kept from deadlocking.

**What a step came after.** When the workflow first asks for a step, the engine works out which earlier steps it needed first, and saves that with the step (`asked_after`). It does this by trying: it replays the workflow once more with an earlier step's result taken away, and if the new step is no longer asked for, the new step needed that one. It decides nothing; it is what lets the dashboard draw a run as a diagram, with an arrow from each step to the ones that came straight after it. The diagram grows as the run goes, since a step isn't known until the workflow asks for it.

**Sticky claiming with steps side by side:** when the step a worker finishes leads to two more, the worker keeps the first and leaves the other for someone else (section 16).

---

## 11. Retries: trying again after an error

Most failures in real systems are temporary: a timeout, a dropped connection, a service restarting. Giving up on the whole payment because a vendor was slow for a second would be silly. So when a step throws, the engine **runs that step again**, and only that step.

**Only the failed step runs again, never the steps before it.** Every finished step is a checkpoint: its output is saved, and the workflow is handed it each time it is replayed (section 4). Retrying the failed step is resuming from the last checkpoint. Starting the run over would redo steps that already worked, side effects and all.

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

So every attempt has a limit, **`timeoutMs`**. A step can set its own; the rest get the engine's `timeoutMs` setting, the one setting with no default, so an engine can't be created without choosing it. When the limit passes, the worker fires the step's `abortSignal`, stops waiting for the step, and records the attempt as failed with the error `Timed out after 6000ms`. From there it's an ordinary failed attempt: it waits out its backoff and runs again, and it counts towards `maxAttempts`. Here is a sanctions check whose vendor doesn't answer the first time:

```
0.0s   attempt 1 claimed     the vendor never answers
6.0s   the time limit passes → abortSignal fires, step_retry_scheduled ("Timed out after 6000ms")
6.5s   attempt 2 claimed     the vendor answers → step_succeeded
```

The worker enforces the limit with a timer of its own; the orchestrator isn't involved and nothing about it is stored. That leaves two cases a timer in the worker can't catch, and the lease already covers both: a worker that died has no timers, and a worker whose event loop is blocked can't run them, but neither can send heartbeats either (section 8).

As with a lost lease, the signal is only a request. If the step's function ignores it, it carries on in the background, and whatever it returns or throws later is thrown away. Its retry may then run while it's still going, which is one more reason for steps with side effects to be safe to repeat (section 12). Changing the limit doesn't make a new version of the workflow (section 3), so it doesn't strand any runs.

**A failure says why.** Every failure is final, so the status is just `failed`. The `failure_reason` column on the step and the run says why, and that tells you what to do about it:

| `failure_reason`     | What happened                                                               | What to do                                                  |
| -------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `non_retryable`      | A step, or the workflow itself, threw a `NonRetryableError`                 | Nothing to fix: it was a decision                           |
| `attempts_exhausted` | A step kept throwing until it ran out of attempts                           | Fix the cause (a vendor outage, a bug), then resume the run |
| `lost_worker`        | A step kept losing its worker until it ran out of attempts                  | Find what kills or stalls the worker                        |
| `unknown_step`       | The workflow never asked for the step when a worker went to run it          | The code changed under the run: see `nondeterministic`      |
| `cancelled`          | The step was running when its run was cancelled, or ended without it        | Nothing: see sections 9 and 14                              |
| `workflow_error`     | The workflow's own code threw, used a step name twice, or gave bad settings | Fix the code, then resume the run                           |
| `nondeterministic`   | The workflow took a different path from the one its saved steps record      | Give the changed code a new `version`, or undo the change   |

A step's reason is one of the first five. A run takes the reason of the step whose failure it didn't catch, or one of the last two.

The dashboard shows the reason next to the Failed badge.

**Resuming a failed run (redrive).** Once you've fixed the cause, you don't have to start again from the beginning. `redriveRun` (the **Resume run** button on the run page) puts the run back to `running` and marks it to be advanced. Steps that succeeded keep their outputs and never run again. Every other step goes back to **`pending`**, which means "to be run again when the workflow asks for it". Then the workflow is replayed as usual: it goes straight through what succeeded, and asks again for the step that failed. It's offered for every reason except `non_retryable`, where asking again won't change a decision, and for a run that was cancelled (section 14).

The resumed steps get **fresh attempts**, but their attempt numbers keep counting up: attempt 5, not attempt 1. The ownership check (section 8) matches on the attempt number, so if it started again from 1, a worker that lost its lease before the run failed, and is somehow still running, could match a new attempt and save a stale result. Instead, `prior_attempts` remembers where the redrive happened, and `maxAttempts` counts only the attempts after it.

---

## 12. Idempotency keys: protecting against duplicates

Leases and retries both mean a step can run **more than once**: in the freeze example, worker-3 really did compute the risk score, and its work was thrown away. If a step does something with side effects and then fails, or its worker crashes before saving, the next attempt does it again. So steps run **at least once**, and any step with side effects must be safe to repeat.

"Idempotent" means "doing it twice has the same effect as doing it once". There are two kinds of keys:

- **Run key (chosen by the caller):** start a run with `idempotency_key: "order-123"` twice, and the second call starts nothing and returns the first run's id. This protects against a double click or a retried HTTP request.
- **Step key (provided by the engine):** a step's `idempotencyKey` is always `runId:stepName`, the same on every attempt. A step passes it to outside services, such as a payment provider, so if the step ever runs again, the provider can say "I've already seen this one" instead of charging twice.

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
  version: "1",
  concurrency: { key: (input) => (input.account ? `account:${input.account}` : null), limit: 1 },
  steps: [...],
});
```

The **key** is worked out from the run's input when it starts. Runs with the same key form a **group**, and at most **`limit`** runs of a group are in progress at once; the rest wait. Payments from different accounts have different keys, so they never wait for each other. A key of `null` means the run is in no group at all, which is why demo payments without an `account` aren't limited. Changing the limit doesn't make a new version of the workflow (section 3), so it doesn't strand anything.

**Waiting and admission.** A run is **in progress** from when it's **admitted** (given a slot) until it finishes, whether it succeeded, failed or was cancelled. `workflow_runs` records three things for this: the run's `concurrency_key`, its `concurrency_limit`, and `admitted_at`.

- **Starting a run:** if its group has a free slot, it's admitted at once and starts like any other run, with an extra `run_admitted` event. If the group is full, it's saved with no `admitted_at` and **isn't marked to be advanced**, and writes `run_waiting`. It stays `queued`.
- **While it waits:** its code hasn't run, so it has no steps, and no worker has anything to do for it. The claim query (section 6) didn't change at all.
- **When a run in the group finishes:** in the same transaction, its slot goes to the **oldest waiting run**, which gets `admitted_at`, writes `run_admitted`, and is marked to be advanced, so a worker runs its code and it asks for its first step.

```
0s     A starts   group "account:acct_shared" has a free slot → admitted, marked to be advanced
0.2s   B starts   the group is full                          → run_waiting, no steps yet
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

- a step that hasn't started becomes `skipped`;
- a step that's `running` becomes `failed`, with the reason `cancelled`;
- the run becomes **`cancelled`**, and its slot goes to the next waiting run.

```
receive-payment   ✅ succeeded
validate-account  ✅ succeeded
score-risk        ❌ failed: "Run cancelled"   (it was running)
screen-sanctions  ❌ failed: "Run cancelled"   (it was running)
post-ledger       never asked for
run               cancelled
```

It is the same thing that happens to a run's unfinished steps when its workflow ends without them (section 9), and the same code does it.

**Cancelled is its own status, not a kind of failure.** Nothing went wrong: someone decided. If a cancelled run were `failed`, it would sit in the Failed tab and be counted with the failures, and anyone watching for failures would be alerted by every run a colleague stopped on purpose. So a run can end three ways, `succeeded`, `failed` or `cancelled`, and the dashboard has a tab and a count for each. A cancelled run has no `failure_reason`; only the steps that were cut off do.

Steps have no `cancelled` status. A step that was running when its run was cancelled really didn't finish, so it's `failed`, and its reason, `cancelled`, says it wasn't the step's fault.

A cancelled run can be resumed like a failed one: **Resume run** puts back the steps that didn't succeed, cut off or skipped, and the workflow carries on from there.

**How does the worker find out?** The cancelled step is no longer `running`, so the worker's next heartbeat finds nothing to renew (section 7). That is exactly what a lost lease looks like: the step's `abortSignal` fires, and if the step finishes anyway, its result matches nothing and is rejected (section 8). The run is over the moment you cancel. Left to its heartbeats, the worker hears within a third of the step's lease; a `run_cancelled` message makes it send one straight away (section 19).

**Stopping steps has a deadlock to avoid.** Everything that changes a run's steps locks the run first (section 10), and so does a cancel, and so does the advance that ends a run. But a claim takes its locks the other way round: it locks the step it is claiming, and then writes a `step_claimed` event, and an event row points at its run. Postgres briefly locks the run for that, to make sure it isn't deleted meanwhile:

```
worker:  claim score-risk               holds the step, now needs the run (for its event)
cancel:  lock the run                   holds the run, now needs the step (to stop it)
         → each waits for the other
```

So the run's lock is a slightly weaker one than the usual, `FOR NO KEY UPDATE` instead of `FOR UPDATE`. It still makes everything that changes the run's steps take turns, but it lets rows that merely point at the run through, so the claim never has to wait for the run.

The cancel then waits for the worker's claim to commit, and fails the step it just claimed. It can do that because it changes all the steps in **one statement** that decides row by row. Two statements, "skip what hasn't started" and then "fail what's running", could miss a step claimed between them, and leave it running in a finished run.

Cancelling a run that is **waiting for a slot** had the same problem with the group lock: the cancel holds the run and wants the group, while a run finishing in that group holds the group and wants the waiting run, to admit it. So admission (section 13) picks and locks its candidate in one query and passes over one that's locked. A locked waiting run is one being cancelled, and the next in line should get the slot anyway.

These are the deadlocks that were found. If two transactions ever do deadlock, Postgres aborts one of them with an error and undoes everything it did. The engine doesn't run it again: the operation fails, so the mistake in the lock order gets noticed.

---

## 15. Schedules: starting runs by the clock

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

**It repeats, or it fires once.** A repeating schedule has a **cron expression**: the usual five fields, read in **UTC**. `0 2 * * *` is two o'clock every night, and `*/15 * * * *` is every quarter of an hour. An expression that can't be read, or that never comes round, is rejected.

A one-time schedule has a moment, `at`, in place of the expression:

```ts
await engine.schedules.create({
  workflow: "greeting",
  name: "launch-day",
  at: new Date("2027-03-01T09:00:00Z"),
  input: { name: "everyone" },
});
```

It starts one run at that moment, and its row stays afterwards with nothing left to fire. A moment that has already passed is rejected. A schedule can't change from one kind to the other.

**A schedule is a row, not part of the workflow.** When a workflow runs, and with what input, changes while everything is running, so a schedule lives only in the `schedules` table and is created and changed through the engine:

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

**A scheduled run is an ordinary run.** It's created by the same code as any other, so it waits its turn in a concurrency group (section 13), can be cancelled (section 14) and writes the same events. The differences are the two columns above, its `run_queued` event, which names the schedule, and what happens at the schedule's next tick.

**When a run outlasts the gap between ticks.** A schedule never has two of its runs going at once. A tick that finds the last one unfinished **starts nothing**, and isn't made up later:

```
09:00  tick → run A starts
09:05  tick → A is still going → skipped
09:12         A finishes
09:15  tick → run B starts
```

The check is one more step in the firing transaction: is there a run with this schedule's `schedule_id` and no `finished_at`? Only the schedule's own runs count, and a run counts until it has succeeded, failed or been cancelled, so one waiting in a concurrency group (section 13) or redriven (section 11) counts too.

A skipped tick has no run of its own to write an event on, so the event goes on the run that was in the way: run A gets a **`schedule_tick_skipped`** event naming the schedule and the tick.

**Where the lock fits.** When a schedule fires, its row is locked before anything else, and the run is then started under it in the usual way (section 13). Nothing that holds a run or a group ever needs a schedule, so firing a schedule can't deadlock with them.

---

## 16. Claim order: which step a worker picks next

When several steps are ready, which one does a worker take? That's the `claimOrder` setting (`demo/workflows/engine.ts`):

- **`sticky` (default):** when a worker finishes a step, it takes the **next step of the same run** right away, inside the same transaction, with a fresh lease. So a run goes start to finish on one worker, apart from branches: if two steps become ready at once, it keeps the first and another worker takes the other. With 3 workers and 10 runs: about 3 run at a time, each finishing quickly.
- **`fair`:** take whichever step has waited longest. Runs take turns, so all 10 start and move forward together.
- **`oldest-run-first`:** take a step from the oldest run, on any worker.

Every step is still saved separately, with its own lease, in all three modes. `sticky` is only a preference, so if the worker dies, any other worker can continue the run. A step put back by the orchestrator joins the queue like any other ready step.

---

## 17. Shutting down gracefully

When you press Ctrl+C on a worker (`closeOnSignals`):

- **First Ctrl+C:** the worker stops claiming new steps but **finishes the step it's on**, then exits. Nothing is cut off mid-way.
- **If that takes longer than `closeTimeoutMs`** (30s), it gives up waiting and exits anyway.
- **Second Ctrl+C:** exits immediately (forced).

In the last two cases the step it abandoned keeps its lease until the lease runs out, then the orchestrator gives it to another worker. A deploy never loses a step.

---

## 18. The store interface: why Postgres is swappable

The engine never writes SQL itself. It only talks to a `WorkflowStore` interface (`workflowEngine.types.ts`):

```ts
interface WorkflowStore {
  syncWorkflows(...)  startRun(...)
  claimStep(...)      completeStep(...)   failStep(...)
  extendLease(...)    sweepExpiredLeases()
  redriveRun(...)     cancelRun(...)
  createSchedule(...) updateSchedule(...) deleteSchedule(...)
  setSchedulePaused(...)                  fireDueSchedules(...)
  advanceRun(...)     relayMessages(...)  close()
}
```

`createPostgresStore()` is one implementation of it. You could write a file-based or SQLite store with the same seventeen methods, and the engine and workers wouldn't change.

`failStep` decides between a retry and a final failure in one transaction, using the settings the step was asked for with. The run lock (section 10) and the group lock (section 13) are the store's business too: the interface only promises that a run is advanced by one process at a time, so that two steps finishing at once are seen one after the other, and that a group never has more than its limit in progress, and each store keeps those promises its own way.

**The store has rows, not your code.** It can't run a workflow, so the methods that advance a run (`advanceRun`, `completeStep`, `failStep`) are handed a function by the engine that does: given what a run has saved, it replays the workflow and returns what it did. The store calls it with the run locked and acts on the answer. `fireDueSchedules` is handed a function the same way (section 15). Leases are part of the same interface on purpose: the ownership check has to happen in the same transaction that saves a step's result, so leases must live wherever step state lives.

---

## 19. Messages: telling workers instead of waiting for them to ask

An idle worker waits to be told there's work (section 5). The simplest way to tell it is a timer, and that has a price. Tick often, and every idle worker queries the database several times a second whether or not there's work. Tick rarely, and a ready step waits. Either way, a worker running a cancelled step only notices at its next heartbeat (section 14). A message fixes all three: something tells the workers.

**A message is a hint, never the truth.** There are two: `step_ready` ("some step may be claimable") and `run_cancelled` ("this run was cancelled"). A worker that gets `step_ready` stops waiting and runs the same claim query as always (section 6). A worker running a step of a cancelled run sends a heartbeat at once, and the store's answer decides whether its step is stopped. So a message that arrives twice or late costs a query and nothing else, because the database still decides.

**Three pieces carry it,** each with one job:

```
store ──(same transaction)──▶ outbox ──(orchestrator's relay)──▶ message broker ──▶ workers
```

1. **The store writes the message to the `outbox` table** in the same transaction as the change it's about: a `step_ready` whenever there is something for a worker to do (a step to claim, or a run to advance), a `run_cancelled` when a run with a running step is cancelled. The message exists exactly when the change committed. Sending it straight to the broker instead would leave a gap: a process that died between the commit and the send would lose the message.
2. **The orchestrator relays.** Every 100ms (`relayIntervalMs`) it takes the waiting rows, publishes them to the broker and deletes them, in one transaction. If the publish fails, nothing is deleted and the next round tries again. If the delete fails after a publish, the message goes out twice. That is **at least once**, the same promise steps get (section 8).
3. **Workers subscribe** to the broker. They never publish.

**The broker is an interface,** like the store (section 18): `publish`, `subscribe`, `close`. There are two:

- **`createPostgresMessageBroker()`** uses Postgres's own `LISTEN` and `NOTIFY`: each worker keeps one connection listening, and Postgres hands every published message to all of them, in whichever process or pod they run.
- **`createPollingMessageBroker()`** is the timer. It carries nothing between processes; it tells its own workers `step_ready` every 250ms. It needs no orchestrator, and nothing can go missing.

Another broker can take their place without the store, the relay or the workers changing.

**A worker has no timer of its own,** so a broker must never leave it waiting on a message it failed to deliver. Postgres keeps no notification for a connection that isn't there, so when the Postgres broker loses its connection, it reconnects and tells its workers `step_ready` itself: it can't know what it missed. Every broker has to do the same after any gap. The Postgres broker adds a slow timer of its own on top, telling its workers to look every 30 seconds whatever it has heard, so a message missed in a way nobody thought of makes a step late, not stuck.

**A backlog drains in a few messages.** If no orchestrator ran for an hour, thousands of `step_ready` rows may be waiting, and they all say the same thing. The relay publishes what a batch means, not each row: one `step_ready` however many there are, and one `run_cancelled` per run.

**A retry's message waits for its backoff.** A step that will retry is claimable when its backoff ends (section 11), not when the failure commits. Its `step_ready` is written with the failure, marked "not before" that moment, and the relay leaves it until then. So the orchestrator sends every message, for new work and for retries alike.

**What a sticky worker keeps to itself.** A worker that finishes a step and takes the run's next one in the same transaction (section 16) leaves nothing for anyone else, so no message is written.

---

## 20. The whole picture

```
 Dashboard ──HTTP──▶ API ──startRun──▶ ┌────────────────────── Postgres ─────────────────────┐
    ▲                 │                │ schedules  workflow_runs  step_runs  events  outbox │
    └─────reads───────┘                └─────────────────────────────────────────────────────┘
                                          ▲  advance / claim /       ▲ sweep expired leases,
                                          │  heartbeat / complete    │ start scheduled runs,
                               ┌──────────┼──────────┐               │ relay the outbox
                           worker-1   worker-2   worker-3      orchestrator
                               ▲          ▲          ▲               │
                               └──────────┴── message broker ◀───────┘
```

1. The **API** starts runs (through the engine, which admits them or makes them wait) and reads tables for the dashboard.
2. **Workers** run your code, for runs of versions they have: the workflow's function, to see what it asks for next, and the steps it asks for, sending heartbeats while a step runs and saving its result.
3. The **orchestrator** gives steps whose worker went silent to another worker, starts a run each time a schedule is due, and relays the messages that tell workers there is work.
4. **Postgres** holds everything, so any process can die and restart without losing progress.

---

## What it doesn't handle yet

- **A retry repeats whatever the failed attempt already did,** unless the step makes it safe to repeat (section 12). The engine can't do that for you.
- **The engine can't tell when a workflow's code changes.** If you edit it and leave its `version` as it was, old and new workers both work on the same runs (section 3).
- **A workflow has rules to keep** (section 4), and the engine can only catch some of the ways to break them. `Promise.race` over steps is one it doesn't support: which step wins isn't saved.
- **A run's later steps aren't known until it asks for them,** so a run can show what it has done, not what it will do.
- **A timed-out step isn't stopped.** The worker stops waiting for it, but unless the step honours its `abortSignal` its function keeps running in the background, and may overlap with its own retry.
- **A stopped step isn't stopped either.** Its worker hears within moments when a message reaches it, and otherwise at its next heartbeat, but the step's function only stops if it honours its `abortSignal`.
- **Every idle worker wakes for one ready step.** A `step_ready` message goes to all of them, one wins the claim, and the rest find nothing.

All seven are listed in `workflowEngine/guarantees.md`.
