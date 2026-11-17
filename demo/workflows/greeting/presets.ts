import type { Preset } from "@ratchet/api/types";
import type { GreetingInput } from "./workflow.ts";

/** The inputs the dashboard offers for the greeting workflow. */
export const presets: Preset<GreetingInput>[] = [
  { label: "Greet the world", input: { name: "world" } },
  { label: "Greet nobody (fails)", input: { name: "" } },
];
