import { EVENT_TONES } from "../constants/events";
import { Pill } from "./Pill";

/** An event's type, such as step_ready, as a pill coloured by what it means. */
export function EventPill({ type }: { type: string }) {
  return <Pill tone={EVENT_TONES[type] ?? "grey"}>{type}</Pill>;
}
