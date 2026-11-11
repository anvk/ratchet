import greeting from "./greeting/workflow.ts";
import { presets as greetingPresets } from "./greeting/presets.ts";
import payment from "./payment/workflow.ts";
import { presets as paymentPresets } from "./payment/presets.ts";

// To add a workflow, create workflows/<name>/workflow.ts and list it here.
// The engine and dashboard pick it up with no other changes.
export const workflows = [payment, greeting];

// Optional, and only for the dashboard: ready-made inputs, by workflow name.
export const presets = {
  [payment.name]: paymentPresets,
  [greeting.name]: greetingPresets,
};
