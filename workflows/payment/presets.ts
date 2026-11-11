import type { Preset } from "@ratchet/api/types";
import type { PaymentInput } from "./workflow.ts";

/** The scenarios the dashboard offers for the payment workflow. */
export const presets: Preset<PaymentInput>[] = [
  { label: "Random payment", input: {} },
  { label: "Payment clears", input: { forceOutcome: "clear" } },
  { label: "Insufficient funds", input: { forceOutcome: "insufficient-funds" } },
  { label: "Declined by risk score", input: { forceOutcome: "risk-declined" } },
  { label: "Sanctions match", input: { forceOutcome: "sanctions-match" } },
  {
    label: "Risk check overloads its worker",
    input: { forceOutcome: "clear", overloadRisk: true },
  },
  { label: "Flaky sanctions vendor", input: { forceOutcome: "clear", vendorTimeouts: 2 } },
  // Times out on all 4 attempts screen-sanctions gets, so the run gives up.
  { label: "Sanctions vendor down", input: { forceOutcome: "clear", vendorTimeouts: 4 } },
  { label: "Ledger write times out", input: { forceOutcome: "clear", ledgerTimeout: true } },
];
