-- The Postgres store's schema. db/schema.gen.ts is generated from it
-- (pnpm db:types), and Docker Compose and the tests apply it.
--
-- What is saved:
--   workflows, schedules              what can be run, and when
--   workflow_runs, step_runs, events  what has been run, and what happened
--   outbox                            messages on their way to the message broker

CREATE TYPE workflow_run_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

CREATE TYPE step_run_status AS ENUM (
  'pending',   -- put back by a redrive; ready again once the workflow asks for it
  'ready',     -- can be claimed now
  'running',
  'succeeded',
  'failed',
  'skipped'    -- asked for and never started, because its run finished or was cancelled first
);

-- Why a step, and so its run, failed. Statuses say what can happen next, and
-- every failure is final; this says why, which tells you what to do about it.
CREATE TYPE failure_reason AS ENUM (
  'non_retryable',      -- the step threw a NonRetryableError, like a declined payment
  'attempts_exhausted', -- it kept throwing until it ran out of attempts
  'lost_worker',        -- it kept losing its worker until it ran out of attempts
  'unknown_step',       -- the workflow's code never asked for the step when a worker went to run it
  'cancelled',          -- the step was running when its run was cancelled, or when its workflow finished without it
  'nondeterministic',   -- the workflow didn't take the path its saved steps say it took before
  'workflow_error'      -- the workflow's own code threw an error that wasn't a step's
);

-- One row per version of a workflow, saved by sync. A workflow is code, so
-- there is nothing else to save about it: a run belongs to the version it
-- started on, and only workers with that version work on it.
CREATE TABLE workflows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  -- The `version` its author gave the definition, such as "2".
  version     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);

-- One row per schedule: a workflow to start, when, and with what. Created and
-- changed through the engine; the orchestrator fires a schedule when
-- next_fire_at has passed and it isn't paused.
CREATE TABLE schedules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow      text NOT NULL,            -- the workflow's name
  name          text NOT NULL,
  -- Null for a schedule that fires once, at next_fire_at.
  cron          text,
  -- What each of its runs starts with.
  input         jsonb NOT NULL DEFAULT '{}',
  -- Set while the schedule is paused. A paused schedule skips its ticks.
  paused_at     timestamptz,
  -- Null once a one-time schedule has fired: it has nothing more to fire.
  next_fire_at  timestamptz,
  -- When it last started a run. A tick skipped because its last run was still
  -- going leaves this alone, and is recorded as an event on that run.
  last_fired_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- A repeating schedule always has a next tick.
  CHECK (cron IS NULL OR next_fire_at IS NOT NULL),
  UNIQUE (workflow, name)
);

-- Lets the orchestrator find due schedules without reading them all.
CREATE INDEX schedules_due_idx ON schedules (next_fire_at) WHERE paused_at IS NULL;

CREATE TABLE workflow_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows (id),
  -- The workflow's version when the run started, copied from workflows so it
  -- can be read here without a join. A run never changes version.
  workflow_version text NOT NULL,
  status      workflow_run_status NOT NULL DEFAULT 'queued',
  input       jsonb NOT NULL DEFAULT '{}',
  -- Set by the caller. Starting a run with a key already used returns that run.
  idempotency_key text UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz,
  -- The failure_reason of the step that failed the run.
  failure_reason failure_reason,
  -- Runs with the same key form a group, of which only so many are in progress
  -- at once. Null for a run in no group.
  concurrency_key text,
  -- How many runs of the group may be in progress at once, copied from the
  -- workflow when the run starts. Null exactly when the key is null.
  concurrency_limit int,
  -- When the run was given a slot. Null while it waits for one; a run in no
  -- group is admitted when it starts.
  admitted_at timestamptz,
  -- Set when something has happened that the workflow's code should see: the
  -- run was admitted or redriven, or a step failed for good with no worker at
  -- hand. A worker with the run's version runs the code again and clears it.
  advance_at  timestamptz,
  -- What the workflow's code returned. Null until the run succeeds.
  output      jsonb,
  -- Set for a run a schedule started: the schedule's id, and the tick it was
  -- for. Not a foreign key, so that deleting a schedule touches only the
  -- schedule's row and never locks or updates its runs.
  schedule_id   uuid,
  scheduled_for timestamptz,
  CHECK ((status = 'failed') = (failure_reason IS NOT NULL)),
  CHECK ((concurrency_key IS NULL) = (concurrency_limit IS NULL)),
  CHECK (concurrency_limit > 0),
  -- A schedule starts at most one run per tick. The orchestrator's lock is what
  -- ensures it; this makes a mistake there fail instead of running twice.
  UNIQUE (schedule_id, scheduled_for)
);

-- Keyset pagination for the runs list, with and without a status filter.
CREATE INDEX workflow_runs_list_idx ON workflow_runs (created_at DESC, id DESC);
CREATE INDEX workflow_runs_status_list_idx ON workflow_runs (status, created_at DESC, id DESC);
-- Finds a group's runs that are waiting or in progress, oldest first.
CREATE INDEX workflow_runs_group_idx ON workflow_runs (concurrency_key, created_at, id)
  WHERE concurrency_key IS NOT NULL AND finished_at IS NULL;
-- Finds a schedule's unfinished run, which makes its next tick start nothing.
CREATE INDEX workflow_runs_schedule_open_idx ON workflow_runs (schedule_id, created_at, id)
  WHERE schedule_id IS NOT NULL AND finished_at IS NULL;

-- Lets a worker find a run whose code should be run again.
CREATE INDEX workflow_runs_advance_idx ON workflow_runs (advance_at)
  WHERE advance_at IS NOT NULL;

CREATE TABLE step_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid NOT NULL REFERENCES workflow_runs (id) ON DELETE CASCADE,
  name        text NOT NULL,
  -- The order in which the workflow first asked for its steps.
  position    int  NOT NULL,
  status      step_run_status NOT NULL DEFAULT 'ready',
  -- The steps this one came straight after: the workflow needed their results
  -- before it asked for this one. For drawing a run, not for deciding anything.
  asked_after text[] NOT NULL DEFAULT '{}',
  -- The settings the workflow gave where it asked for the step. Null means the
  -- engine's default.
  lease_ms     int CHECK (lease_ms > 0),
  max_attempts int CHECK (max_attempts > 0),
  backoff_ms   int CHECK (backoff_ms >= 0),
  attempt     int  NOT NULL DEFAULT 0,
  -- Attempts made before the run was last redriven. Attempt numbers never go
  -- back, so a worker from before can't match a new attempt; maxAttempts
  -- counts only the attempts after this.
  prior_attempts int NOT NULL DEFAULT 0,
  worker_id   text,
  output      jsonb,
  error       text,
  ready_at    timestamptz,
  started_at  timestamptz,
  finished_at timestamptz,
  -- While running: the worker owns the step until then, unless it extends the
  -- lease with a heartbeat. After that, the orchestrator makes the step ready again.
  lease_expires_at timestamptz,
  -- Set exactly when the step has failed.
  failure_reason failure_reason,
  CHECK ((status = 'failed') = (failure_reason IS NOT NULL)),
  UNIQUE (run_id, name),
  UNIQUE (run_id, position)
);

-- Small because it covers only claimable steps, however much history builds up.
-- Also serves retries: a step waiting to retry is ready with ready_at in the future.
CREATE INDEX step_runs_claim_idx ON step_runs (ready_at, id) WHERE status = 'ready';
-- Lets the orchestrator find expired leases without scanning finished steps.
CREATE INDEX step_runs_lease_idx ON step_runs (lease_expires_at) WHERE status = 'running';

-- Append-only history, written in the same transaction as each state change.
CREATE TABLE events (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id    uuid NOT NULL REFERENCES workflow_runs (id) ON DELETE CASCADE,
  step_name text,
  type      text NOT NULL,
  attempt   int,
  worker_id text,
  detail    jsonb,
  -- clock_timestamp, not now(): now() is frozen at the start of a transaction.
  at        timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX events_run_idx ON events (run_id, id);

-- Messages waiting to be published to the message broker. Each is written in
-- the same transaction as the change it is about, so it exists exactly when
-- that change committed, and deleted once the orchestrator has published it.
-- The table holds only what hasn't gone out yet.
CREATE TABLE outbox (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type       text NOT NULL, -- step_ready or run_cancelled
  -- The run a run_cancelled message is about. Null for step_ready. Not a
  -- foreign key, so writing a message never locks the run.
  run_id     uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- The orchestrator leaves the message alone until then. Later than now only
  -- for a retry, whose message is for the moment its backoff ends.
  publish_at timestamptz NOT NULL DEFAULT now()
);
