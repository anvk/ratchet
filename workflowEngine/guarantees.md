# Guarantees

What the engine promises. Each guarantee is backed by a test in
`workflowEngine/tests/`.

- **A step is claimed at most once.** Competing workers never run the same step.
- **Steps run in order.** A step becomes ready only after the one before it succeeds.
- **A failure ends the run.** The failed step is final, later steps become
  `skipped`, and the run becomes `failed`.
- **A repeated key starts one run.** Starting a run with an idempotency key the
  caller already used returns the existing run.
- **Each step has a stable key.** `ctx.idempotencyKey` doesn't change between
  retries of a step.
- **History matches state.** Every state change and its event commit in the
  same transaction.
- **Workers pick steps by the engine's claim order.**
  - `sticky` (default): a worker that finishes a step takes the run's next step
    in the same transaction, so a run stays on one worker from start to finish.
  - `fair`: the step that has been ready the longest goes first, so runs take
    turns.
  - `oldest-run-first`: steps from the oldest run go first.

## Limitations

- **A worker that dies mid-step leaves it `running` forever.**
- **Nothing retries, so a temporary failure ends the run.**
