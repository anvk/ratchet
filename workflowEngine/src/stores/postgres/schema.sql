-- The Postgres store's schema. db/schema.gen.ts is generated from it
-- (pnpm db:types), and Docker Compose and the tests apply it.
--
-- Two kinds of data, like a recipe and cooking that recipe tonight:
--   the plan:      workflows, steps
--   the execution: workflow_runs, step_runs, events

CREATE TYPE workflow_run_status AS ENUM ('queued', 'running', 'succeeded', 'failed');

CREATE TYPE step_run_status AS ENUM (
  'pending',   -- a step it needs has not finished
  'ready',     -- can be claimed now
  'running',
  'succeeded',
  'failed',
  'skipped',   -- never started, because the run failed
  'cancelled'  -- was running when the run failed, and was told to stop
);

-- Why a step, and so its run, failed. Statuses say what can happen next, and
-- every failure is final; this says why, which tells you what to do about it.
CREATE TYPE failure_reason AS ENUM (
  'non_retryable',      -- the step threw a NonRetryableError, like a declined payment
  'attempts_exhausted', -- it kept throwing until it ran out of attempts
  'lost_worker',        -- it kept losing its worker until it ran out of attempts
  'unknown_step'        -- no worker running it had code for the step
);

-- One row per version of a workflow, copied from the registry at API startup.
-- Plan rows never change. Editing a workflow creates a new version, so past
-- runs keep showing the steps they actually ran.
CREATE TABLE workflows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  version     text NOT NULL, -- hash of the definition
  title       text NOT NULL,
  description text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);

CREATE TABLE steps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
  name        text NOT NULL,
  title       text NOT NULL,
  description text NOT NULL,
  position    int  NOT NULL,
  -- Steps that must succeed before this one can start. They always come
  -- earlier in position, so the steps can't form a loop.
  needs       text[] NOT NULL DEFAULT '{}',
  -- How long a worker may go without a heartbeat before the step is given to
  -- another worker. Null means the engine's default.
  lease_ms    int  CHECK (lease_ms > 0),
  -- How many times the step may run before its run fails, and the first wait
  -- before a retry (doubling each time). Null means the engine's defaults.
  max_attempts int CHECK (max_attempts > 0),
  backoff_ms   int CHECK (backoff_ms >= 0),
  UNIQUE (workflow_id, name),
  UNIQUE (workflow_id, position)
);

CREATE TABLE workflow_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows (id),
  status      workflow_run_status NOT NULL DEFAULT 'queued',
  input       jsonb NOT NULL DEFAULT '{}',
  -- Set by the caller. Starting a run with a key already used returns that run.
  idempotency_key text UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz,
  -- The failure_reason of the step that failed the run.
  failure_reason failure_reason,
  CHECK ((status = 'failed') = (failure_reason IS NOT NULL))
);

-- Keyset pagination for the runs list, with and without a status filter.
CREATE INDEX workflow_runs_list_idx ON workflow_runs (created_at DESC, id DESC);
CREATE INDEX workflow_runs_status_list_idx ON workflow_runs (status, created_at DESC, id DESC);

CREATE TABLE step_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid NOT NULL REFERENCES workflow_runs (id) ON DELETE CASCADE,
  -- Nullable, with name and position stored here, so an agent workflow can add
  -- steps at runtime that were never in the plan.
  step_id     uuid REFERENCES steps (id),
  name        text NOT NULL,
  position    int  NOT NULL,
  status      step_run_status NOT NULL DEFAULT 'pending',
  -- Copied from the plan, so a step added at runtime can have needs too.
  needs       text[] NOT NULL DEFAULT '{}',
  attempt     int  NOT NULL DEFAULT 0,
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
