import type { ComponentProps } from "react";
import { CONTROL_CLASSES } from "./Button";

/** A dropdown styled like the buttons. */
export function Select({ className = "", ...props }: ComponentProps<"select">) {
  return (
    <select
      className={`${CONTROL_CLASSES} border-line bg-surface text-ink ${className}`}
      {...props}
    />
  );
}
