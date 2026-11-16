# Guarantees

What the engine promises. Each guarantee is backed by a test in
`workflowEngine/tests/`.

- **One worker holds a step at a time.** Competing workers never claim the same
  step at once.
- **A worker only runs steps it has the same code for.** A run belongs to the
  workflow version it started on, and workers only claim runs of versions they
  have. During a deploy, old workers finish old runs and new workers take new
  ones.
- **A step whose worker disappears runs again.** Each claim comes with a lease,
  which the worker renews with heartbeats while the step runs. When a lease
  expires (the worker crashed, froze or lost its connection), the orchestrator
  makes the step ready, and the next claim is a new attempt. So steps run **at
  least once**: anything with side effects should use `ctx.idempotencyKey`.
- **A step that lost its lease can't finish it.** Its renewals fail, `ctx.signal`
  fires, and its late result is rejected, because the step's worker and attempt
  no longer match.
- **A step's lease is its own `leaseMs`, or the engine's default.** This holds
  for every claim, including the sticky handoff to the next step.
- **A step starts only once everything it needs has succeeded.** Its `needs`,
  or the step listed before it. Steps whose needs are met run side by side.
- **A step that needs several others is readied exactly once,** even when they
  finish at the same moment on different workers: every change to a started
  run's steps locks the run first, so they take turns.
- **A step only sees the outputs of steps it depends on,** directly or through
  others, never those of a step running alongside it.
- **A step can only need steps listed before it,** so a workflow can't have
  unknown names or loops; `defineWorkflow` rejects them.
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
- **A step attempt is given up on after its `timeoutMs`.** The worker fires
  `ctx.signal`, stops waiting for the step, and records a failed attempt, which
  is retried like any other error while attempts are left. Steps without
  `timeoutMs` have no limit.
- **A step that fails for good only stops what depends on it.** Steps that
  depend on it, directly or not, become `skipped`. Every other step carries
  on: running steps finish and ready steps still start. Once nothing can move,
  the run becomes `failed`, with the reason of the step that failed first.
- **A failed run can be resumed if a fix could cure it.** Redriving a run that
  failed with `attempts_exhausted`, `lost_worker` or `unknown_step` reruns the
  steps that didn't succeed, with fresh attempts; steps that succeeded keep
  their outputs. Attempt numbers keep counting up, so a worker from before
  can't save over a new attempt. `non_retryable` runs can't be redriven.
- **A run can be cancelled until it finishes.** Steps that haven't started
  become `skipped`; a running step fails with reason `cancelled` and its late
  result is rejected; the run becomes `cancelled`, not `failed`, and gives up
  its concurrency slot. Cancelling takes the run's lock and changes every step in
  one statement, so it can't miss a step that is being claimed. A cancelled run
  can be resumed with a redrive.
- **Every failed step and run records why.** `failure_reason` is set exactly
  when the status is `failed` (a database check enforces it): `non_retryable`,
  `attempts_exhausted`, `lost_worker`, `unknown_step` or `cancelled`. On a step,
  `cancelled` means it was running when its run was cancelled; the run itself
  is `cancelled` with no failure reason.
- **A concurrency group never runs more than its limit at once.** At most
  `limit` runs with the same concurrency key are in progress; a run is in
  progress from when it is admitted until it finishes (succeeded, failed or
  cancelled). The others wait with no step ready, and are admitted oldest first as slots free
  up. A run that fails or is redriven goes through the same admission. Counting
  the slots and admitting a run happen under one lock per key, so two runs can't
  take the same slot.
- **A schedule starts one run per tick, however many orchestrators are
  running.** An orchestrator locks the due schedule's row (skipping rows another
  has locked), and the run and the move to the next tick commit together. A
  unique constraint on the schedule and tick backs it: if the lock were ever
  wrong, the second run would fail to insert rather than run twice.
- **Ticks missed while no orchestrator was running start one run,** for the
  oldest missed tick, not one each. The schedule then resumes from now.
- **A scheduled run is an ordinary run.** It goes through the same code as
  `startRun`, so concurrency groups, admission and events apply to it.
- **A repeated key starts one run.** Starting a run with an idempotency key the
  caller already used returns the existing run.
- **Each step has a stable key.** `ctx.idempotencyKey` is the same on every
  attempt of a step.
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
  unique key or `ctx.idempotencyKey`.
- **A timed-out step's function isn't stopped.** Unless it honours `ctx.signal`
  it keeps running in the background, and may overlap with its own retry.
- **A running step hears about a cancel at its next heartbeat,** up to a third
  of its lease later, and its function isn't stopped. Unless it honours
  `ctx.signal` it keeps running until it returns, and its result is discarded.
- **A step without `timeoutMs` that never returns runs forever,** for as long as
  its worker stays alive.
- **A failed run ends only when its last running step does,** since steps
  that don't depend on the failure finish first.
- **A version covers the plan, not the code.** Editing only the code inside a
  step's `run` doesn't create a new version, so workers with either code
  claim the same runs.
- **Lost leases are only recovered while an orchestrator is running.** Without
  one, steps whose lease expired stay `running`.
- **A step that blocks the event loop for longer than its lease loses it,**
  because heartbeats can't run. Give heavy synchronous steps a longer `leaseMs`.
- **A run that never finishes keeps its concurrency slot.** If no worker can
  claim its steps (for example, no worker has its version), it stays in
  progress, and the runs waiting behind it in its group wait too, until someone
  cancels it.
- **Schedules only fire while an orchestrator is running.** Without one, nothing
  starts a scheduled run.
- **Schedule times are UTC and to the minute,** and a run starts up to
  `sweepIntervalMs` after its minute.
- **A tick starts a run even if the previous one is still going,** unless the
  workflow's `concurrency` prevents it.
