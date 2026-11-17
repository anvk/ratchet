import type { ComponentProps } from "react";

/** A bordered box on the page, such as the step details or the event list. */
export function Panel({ className = "", ...props }: ComponentProps<"section">) {
  return (
    <section className={`rounded-lg border border-line bg-surface p-4 ${className}`} {...props} />
  );
}
