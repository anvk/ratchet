import greeting from "./greeting/workflow.ts";
import payment from "./payment/workflow.ts";

// To add a workflow, create workflows/<name>/workflow.ts and list it here.
// The engine and dashboard pick it up with no other changes.
export const workflows = [payment, greeting];
