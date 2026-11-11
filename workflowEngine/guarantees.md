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
- **A step that fails for good ends the run.** The step is final, steps still
  running become `cancelled` (their workers lose them at the next heartbeat,
  and any late result is rejected), steps that never started become
  `skipped`, and the run becomes `failed`.
- **A failed run can be resumed if a fix could cure it.** Redriving a run that
  failed with `attempts_exhausted`, `lost_worker` or `unknown_step` reruns the
  steps that didn't succeed, with fresh attempts; steps that succeeded keep
  their outputs. Attempt numbers keep counting up, so a worker from before
  can't save over a new attempt. `non_retryable` runs can't be redriven.
- **Every failed step and run records why.** `failure_reason` is set exactly
  when the status is `failed` (a database check enforces it): `non_retryable`,
  `attempts_exhausted`, `lost_worker` or `unknown_step`.
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
- **Cancelling a step can't force it to stop.** Its worker finds out at the
  next heartbeat and should stop if the step listens to `ctx.signal`; otherwise
  it keeps working and only its result is thrown away.
- **A version covers the plan, not the code.** Editing only the code inside a
  step's `run` doesn't create a new version, so workers with either code
  claim the same runs.
- **Lost leases are only recovered while an orchestrator is running.** Without
  one, steps whose lease expired stay `running`.
- **A step that blocks the event loop for longer than its lease loses it,**
  because heartbeats can't run. Give heavy synchronous steps a longer `leaseMs`.
