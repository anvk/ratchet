import greeting from "./greeting/workflow.ts";
import { presets as greetingPresets } from "./greeting/presets.ts";
import payment from "./payment/workflow.ts";
import { presets as paymentPresets } from "./payment/presets.ts";

// To add a workflow, create workflows/<name>/workflow.ts and list it here, with
// its labels. The engine and dashboard pick it up with no other changes.
export const workflows = [payment.definition, greeting.definition];

// Optional, and only for the dashboard: ready-made inputs, by workflow name.
export const presets = {
  [payment.definition.name]: paymentPresets,
  [greeting.definition.name]: greetingPresets,
};

// Only for the dashboard: the titles and descriptions it shows, by workflow name.
export const labels = {
  [payment.definition.name]: payment.labels,
  [greeting.definition.name]: greeting.labels,
};
