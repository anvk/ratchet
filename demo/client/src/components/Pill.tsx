import type { ReactNode } from "react";

/** The colours a pill can take, from the theme in index.css. */
export type PillTone = "grey" | "blue" | "green" | "red" | "amber";

const TONES: Record<PillTone, string> = {
  grey: "bg-grey-soft text-grey",
  blue: "bg-blue-soft text-blue",
  green: "bg-green-soft text-green",
  red: "bg-red-soft text-red",
  amber: "bg-amber-soft text-amber",
};

/** A small rounded label, optionally with a dot in front that can pulse. */
export function Pill({
  tone,
  dot = false,
  pulse = false,
  children,
}: {
  tone: PillTone;
  dot?: boolean;
  pulse?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.25 py-px text-xs/normal font-medium whitespace-nowrap ${TONES[tone]}`}
    >
      {dot && (
        <span
          className={`size-1.75 rounded-full bg-current ${pulse ? "animate-pulse-soft motion-reduce:animate-none" : ""}`}
          aria-hidden
        />
      )}
      {children}
    </span>
  );
}
