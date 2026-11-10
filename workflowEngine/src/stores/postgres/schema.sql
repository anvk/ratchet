-- The Postgres store's schema. db/schema.gen.ts is generated from it
-- (pnpm db:types), and Docker Compose and the tests apply it.
--
-- Two kinds of data, like a recipe and cooking that recipe tonight:
--   the plan:      workflows, steps
--   the execution: workflow_runs, step_runs, events

CREATE TYPE workflow_run_status AS ENUM ('queued', 'running', 'succeeded', 'failed');

CREATE TYPE step_run_status AS ENUM (
  'pending',   -- an earlier step has not finished
  'ready',     -- can be claimed now
  'running',
  'succeeded',
  'failed',
  'skipped'
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
  finished_at timestamptz
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
  attempt     int  NOT NULL DEFAULT 0,
  worker_id   text,
  output      jsonb,
  error       text,
  ready_at    timestamptz,
  started_at  timestamptz,
  finished_at timestamptz,
  UNIQUE (run_id, name),
  UNIQUE (run_id, position)
);

-- Small because it covers only claimable steps, however much history builds up.
CREATE INDEX step_runs_claim_idx ON step_runs (ready_at, id) WHERE status = 'ready';

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
