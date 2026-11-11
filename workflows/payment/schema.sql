-- Tables owned by the fake payments example, not by the engine.
--
-- Amounts are integer cents, never floats.
--
-- A payment has exactly one debit and one credit. The unique key makes posting
-- safe to repeat: steps can run more than once (a retry after a lost reply, a
-- worker that lost its lease), and a second post must not charge twice.

CREATE TABLE ledger_entries (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_id   text   NOT NULL,
  account      text   NOT NULL,
  direction    text   NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id, direction)
);
