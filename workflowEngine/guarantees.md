# Guarantees

What the engine promises. Each guarantee is backed by a test in
`workflowEngine/tests/`.

A workflow is code: a function that asks for steps and returns the run's
output. The guarantees about recovering lost steps and about schedules are kept
by the orchestrator, so they hold while at least one orchestrator is running.
Workers only run your code: the workflow's, to see what it asks for next, and
the steps'.

## Workflows as code

- **A workflow is run again from the top, and a step that has finished never
  runs again.** Each time something happens in a run, its code is run against
  what the run has saved. A step whose output is saved hands it back at once,
  so the code goes straight to the first thing it doesn't have yet.
- **A step runs when the workflow asks for it.** A run has no steps until its
  code asks. Steps asked for without waiting in between, as in `Promise.all`,
  are asked for together and run side by side.
- **A step that waits for several others is asked for exactly once,** even
  when they finish at the same moment on different workers. What a run does
  next is only ever decided with the run locked, from everything saved by
  then, so one of the two finishing steps is seen second, with both results.
- **A run lasts exactly as long as its workflow's code.** When the code
  returns, the run succeeds with what it returned as its output. When it
  throws, the run fails. Either way the run is over at once: a step it asked
  for that hasn't started becomes `skipped`, and a step still running is failed
  with reason `cancelled`, its worker told, and its late result rejected.
- **A step that fails for good is thrown into the workflow, where it asked for
  the step.** As a `StepFailedError`, with the step's reason and message. The
  workflow may catch it and carry on, for example to undo earlier work. If it
  doesn't, the run fails with that step's reason.
- **An error in the workflow's own code fails the run.** With
  `non_retryable` for a `NonRetryableError`, and `workflow_error` for anything
  else.
- **A workflow that takes a different path than before fails its run, it
  doesn't quietly do something else.** If the code doesn't ask again for a step
  the run has saved, or waits on something that isn't a step, the run fails
  with `nondeterministic`. That happens when the code changed under the run
  without a new `version`, or decides on something that isn't saved.
- **A step name is used once in a run, and a step's settings must make sense.**
  Otherwise the run fails with `workflow_error`.
- **A step is found by running the workflow up to it.** A worker that claims a
  step runs the workflow's code, with the results saved when it claimed, until
  the code asks for that step, and runs the function given there. If the code
  never asks, the step fails with `unknown_step`.
- **A step's settings come from where the workflow asks for it.** `leaseMs`,
  `maxAttempts`, `backoffMs` and `timeoutMs`, each falling back to the engine's.
- **Only a worker with a run's version runs its code.** That includes working
  out what it does next, not only running its steps.
- **A step records the steps it came straight after:** those whose results the
  workflow needed before it asked for this one. It is for showing a run, and
  decides nothing.

## Steps, runs, schedules and messages

- **One worker holds a step at a time.** Competing workers never claim the same
  step at once.
- **A worker only works on runs it has the same code for.** A run belongs to
  the workflow version it started on, and workers only claim steps, and only
  advance runs, of versions they have. During a deploy, old workers finish old
  runs and new workers take new ones.
- **A workflow gets a new version when its `version` changes, and only then.**
  `version` is text every workflow must give. The engine can't see inside the
  code, so changing it is how you keep workers with old code and workers with
  new from sharing a run.
- **A run records the version it started on.** Its `workflow_version` is the
  definition's `version` at that moment and never changes, whatever is
  deployed later. That goes for runs a schedule starts too.
- **A step whose worker disappears runs again.** Each claim comes with a lease,
  which the worker renews with heartbeats while the step runs. When a lease
  expires (the worker crashed, froze or lost its connection), the orchestrator
  makes the step ready, and the next claim is a new attempt. So steps run **at
  least once**: anything with side effects should use the step's
  `idempotencyKey`.
- **A step that lost its lease can't finish it.** Its renewals fail, its
  `abortSignal` fires, and its late result is rejected, because the step's
  worker and attempt no longer match.
- **A step's lease is its own `leaseMs`, or the engine's default.** This holds
  for every claim, including the sticky handoff to the next step.

- **A failed step is retried, from where it failed.** A step that throws runs
  again after a backoff (`backoffMs`, doubling each time, capped at
  `maxBackoffMs`, spread by up to 20%), while it has attempts left. Steps that
  already succeeded never run again: their outputs are kept.
- **A retry doesn't start before its backoff is over.** A step waiting to retry
  is `ready`, but no worker can claim it until its time comes.
- **A `NonRetryableError` fails the step at once,** whatever attempts it has
  left. It's for decisions ("insufficient funds"), not glitches.
- **Every step has a limit on attempts.** Its own `maxAttempts`, or the
  engine's default. Errors and lost leases both use up attempts, so a step that
  keeps crashing its worker stops too.
- **Every step attempt has a time limit.** The step's own `timeoutMs`, or the
  engine's, which has no default: an engine can't be created without one. When
  the limit passes, the worker fires the step's `abortSignal`, stops waiting
  for the step, and records a failed attempt, which is retried like any other
  error while attempts are left.

- **A failed run can be resumed if a fix could cure it.** Redriving a run that
  failed with `attempts_exhausted`, `lost_worker`, `unknown_step`,
  `workflow_error` or `nondeterministic` runs its workflow again from the top.
  Steps that succeeded keep their outputs and don't run again. Every other step
  goes back to `pending`, and runs again, with fresh attempts, when the
  workflow asks for it. Attempt numbers keep counting up, so a worker from
  before can't save over a new attempt. `non_retryable` runs can't be redriven.
- **A run can be cancelled until it finishes.** A step that hasn't started
  becomes `skipped`; a running step fails with reason `cancelled` and its late
  result is rejected; the run becomes `cancelled`, not `failed`, and gives up
  its concurrency slot. Cancelling takes the run's lock and changes every step in
  one statement, so it can't miss a step that is being claimed. A cancelled run
  can be resumed with a redrive.
- **Every failed step and run records why.** `failure_reason` is set exactly
  when the status is `failed` (a database check enforces it): `non_retryable`,
  `attempts_exhausted`, `lost_worker`, `unknown_step`, `cancelled`,
  `workflow_error` or `nondeterministic`. On a step, `cancelled` means it was
  running when its run was cancelled, or when its workflow finished without
  it; a cancelled run itself is `cancelled` with no failure reason.
- **A concurrency group never runs more than its limit at once.** At most
  `limit` runs with the same concurrency key are in progress; a run is in
  progress from when it is admitted until it finishes (succeeded, failed or
  cancelled). The others wait, with their code not yet run and so no steps,
  and are admitted oldest first as slots free up. A run that fails or is redriven goes through the same admission. Counting
  the slots and admitting a run happen under one lock per key, so two runs can't
  take the same slot.
- **Schedules are created and changed through the engine, and survive restarts
  and `sync()`.** `engine.schedules` creates, updates, pauses, resumes and
  deletes them. Each is a row in the database, not part of a workflow's
  definition or version, so syncing or restarting never changes one.
- **A schedule starts one run per tick, however many orchestrators are
  running.** An orchestrator locks the due schedule's row (skipping rows another
  has locked, such as one being edited), and the run and the move to the next
  tick commit together. A unique constraint on the schedule and tick backs it:
  if the lock were ever wrong, the second run would fail to insert rather than
  run twice.
- **A schedule fires once or repeats, never both.** A schedule with an `at`
  starts one run at that moment and then has no next tick; it never fires
  again. One with a `cron` repeats. An `at` in the past is rejected.
- **A schedule never has two of its runs going at once.** A tick that comes
  due while a run the schedule started hasn't finished starts nothing, and
  isn't made up later; the schedule waits for its next tick. That run gets a
  `schedule_tick_skipped` event naming the schedule and the tick, so its
  history shows every tick it held back. Only the schedule's own runs count,
  and a run counts until it has succeeded, failed or been cancelled, so one
  waiting in a concurrency group counts, and so does one that was redriven.
  The check is made under the schedule's lock, in the transaction that would
  have started the run.
- **A paused schedule skips its ticks.** It starts nothing while paused, and
  resuming continues from the next tick after now, with no run for the ticks it
  skipped. A one-time schedule has no other tick to skip to, so one paused
  through its moment fires when it is resumed.
- **A change to a schedule's cron takes effect from now.** The next tick is the
  first one after the change; changing only the input keeps the next tick.
- **Ticks missed while no orchestrator was running start one run,** for the
  oldest missed tick, not one each. The schedule then resumes from now. A
  one-time schedule missed this way fires once when an orchestrator returns.
- **An orchestrator only fires schedules of its own workflows.** A schedule of
  a workflow it doesn't have is left alone, without an error.
- **A scheduled run is an ordinary run.** It goes through the same code as
  `startRun`, so concurrency groups, admission and events apply to it. The one
  difference is that it holds back its schedule's next tick until it finishes.
- **A repeated key starts one run.** Starting a run with an idempotency key the
  caller already used returns the existing run.
- **Each step has a stable key.** Its `idempotencyKey` is the same on every
  attempt of a step.
- **A message is saved with the change it is about.** Making a step claimable
  saves a `step_ready` message, and cancelling a run with a running step saves
  a `run_cancelled` one, in the same transaction as the change. A step that
  will retry gets its message with the failure, held back until its backoff is
  over, so the orchestrator sends the message for new work and for retries. A change that
  doesn't commit leaves no message, and one that commits always leaves its
  message.
- **A saved message stays until it has been published.** The orchestrator
  relays the outbox to the message broker and deletes a message only in the
  transaction that published it, so a broker that is down delays messages
  without losing them. Delivery is **at least once**: a message can be
  published twice. Two orchestrators never relay the same message at once.
- **A backlog is relayed as a few messages.** Any number of waiting
  `step_ready` messages are published as one, and several `run_cancelled` for
  one run as one.
- **A message is only ever a hint.** A worker that gets `step_ready` claims
  through the store as always, and one that gets `run_cancelled` asks the store
  whether it still owns its step. A repeated or stale message can't start or
  stop anything by itself.
- **A worker with nothing to do waits for a `step_ready` message, and claims
  as soon as one arrives.** It has no timer of its own; how often it looks is
  up to the message broker.
- **The Postgres message broker tells its workers to look for work after its
  connection was lost,** since it can't know what it missed. So a worker never
  waits on a message that was published while it couldn't listen.
- **The Postgres message broker also tells its workers to look every
  `everyMs`,** 30 seconds by default, whatever it has heard. A message missed
  in a way nobody foresaw makes a step late by that long at most, not stuck.
- **The polling message broker needs no orchestrator and no messages.** It
  tells its workers to look every `everyMs`, whatever is or isn't published.
- **History matches state.** Every state change and its event commit in the
  same transaction.
- **Workers pick steps by the engine's claim order.**
  - `sticky` (default): a worker that finishes a step takes the run's next step
    in the same transaction, so a run stays on one worker from start to finish.
    When several steps become ready at once, it takes the first.
  - `fair`: the step that has been ready the longest goes first, so runs take
    turns.
  - `oldest-run-first`: steps from the oldest run go first.

## Limitations

- **A retry repeats whatever the failed attempt already did.** If a step wrote
  something and then failed (or its reply was lost), the retry writes it again,
  unless the step makes its side effects safe to repeat, for example with a
  unique key or the step's `idempotencyKey`.
- **A timed-out step's function isn't stopped.** Unless it honours its
  `abortSignal` it keeps running in the background, and may overlap with its
  own retry.
- **A stopped step's function isn't stopped.** A step that was running when
  its run was cancelled, or when its workflow finished without it, is failed
  in the database at once. Its worker hears within moments when a
  `run_cancelled` message reaches it, and otherwise at its next heartbeat, up
  to a third of its lease later. Unless the function honours its `abortSignal`
  it keeps running until it returns, and its result is discarded.
- **With the Postgres message broker, work is slow while no orchestrator is
  running.** Only the orchestrator tells workers when there is work, so without
  one they look just once every `everyMs`. When one returns it sends what is
  waiting, and work carries on at full speed.
- **Every idle worker wakes for one ready step.** A `step_ready` message goes
  to all subscribers; one wins the claim and the rest find nothing.
- **The Postgres message broker needs a direct connection to listen on.** A
  pooler that hands out connections per transaction can't deliver
  notifications.
- **A workflow has rules it must keep.** It may only wait on `ctx`, and it
  must take the same path every time it is run with the same saved results, so
  the clock, random numbers and anything outside the process belong inside a
  step. Breaking them fails the run with `nondeterministic` where the engine
  can tell, which is not always.
- **`Promise.race` over steps isn't supported.** Which step wins depends on
  which finished first, and that isn't saved: the next time the workflow runs,
  with both finished, the race picks the first one listed. The run fails with
  `nondeterministic` if that changes its path.
- **A workflow's later steps aren't known until it asks for them.** A run can
  show what it has done, not what it will do.
- **Every step asks the workflow's code to be run again.** A worker runs it
  once to find a step and once to see what comes next, so the work grows with
  the number of steps a run has saved. It is quick (about a fifth of a
  millisecond with a thousand saved steps), but a run isn't meant to have
  hundreds of thousands of steps.
- **A step's output must survive being saved as JSON.** The workflow gets back
  what was saved, so `undefined` comes back as `null` and a `Date` as text.
- **The engine can't tell when a workflow's code changes.** A workflow gets a
  new version only when its `version` changes. If you edit the code and leave
  `version` as it was, workers with either code work on the same runs, and a
  run in progress carries on with the new code.
- **A step that blocks the event loop for longer than its lease loses it,**
  because heartbeats can't run. Give heavy synchronous steps a longer `leaseMs`.
- **A run that never finishes keeps its concurrency slot.** If no worker can
  work on it (for example, no worker has its version), it stays in progress,
  and the runs waiting behind it in its group wait too, until someone cancels
  it.
- **A new database has no schedules.** They live only in the database, so
  something has to create them.
- **Schedule times are UTC and to the minute,** and a run starts up to
  `sweepIntervalMs` after its minute. A one-time schedule's `at` is used as
  given.
- **A schedule can't be told to let its runs overlap.** For runs that may
  overlap, create a second schedule or start them with `startRun`.
