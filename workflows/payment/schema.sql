-- Tables owned by the fake payments example, not by the engine.
--
-- Amounts are integer cents, never floats.

CREATE TABLE ledger_entries (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_id   text   NOT NULL,
  account      text   NOT NULL,
  direction    text   NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ledger_entries_payment_idx ON ledger_entries (payment_id);
