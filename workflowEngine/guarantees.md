# Guarantees

What the engine promises. Each guarantee is backed by a test in
`workflowEngine/tests/`.

- **One worker holds a step at a time.** Competing workers never claim the same
  step at once.
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
- **Steps run in order.** A step becomes ready only after the one before it succeeds.
- **A failure ends the run.** The failed step is final, later steps become
  `skipped`, and the run becomes `failed`.
- **A repeated key starts one run.** Starting a run with an idempotency key the
  caller already used returns the existing run.
- **Each step has a stable key.** `ctx.idempotencyKey` is the same on every
  attempt of a step.
- **History matches state.** Every state change and its event commit in the
  same transaction.
- **Workers pick steps by the engine's claim order.**
  - `sticky` (default): a worker that finishes a step takes the run's next step
    in the same transaction, so a run stays on one worker from start to finish.
  - `fair`: the step that has been ready the longest goes first, so runs take
    turns.
  - `oldest-run-first`: steps from the oldest run go first.

## Limitations

- **Nothing retries a failed step, so a temporary failure ends the run.** Only
  a lost lease runs a step again.
- **A step that keeps killing its worker runs again forever.** There's no limit
  on attempts yet.
- **Steps run again only while an orchestrator is running.** Without one,
  expired leases stay `running`.
- **A step that blocks the event loop for longer than its lease loses it,**
  because heartbeats can't run. Give heavy synchronous steps a longer `leaseMs`.
