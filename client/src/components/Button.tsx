import type { ComponentProps } from "react";

/** Size, border and disabled look shared by buttons and dropdowns, so they match side by side. */
export const CONTROL_CLASSES =
  "h-8.5 rounded-md border px-3 enabled:cursor-pointer disabled:opacity-50";

const VARIANTS = {
  default: "border-line bg-surface text-ink",
  primary: "border-accent bg-accent font-semibold text-page",
  // Selected through aria-selected, which tabs set anyway.
  tab: "flex-none border-transparent bg-transparent text-muted aria-selected:border-line aria-selected:bg-surface aria-selected:font-semibold aria-selected:text-ink",
};

/** A button in one of the dashboard's styles. */
export function Button({
  variant = "default",
  className = "",
  ...props
}: ComponentProps<"button"> & { variant?: keyof typeof VARIANTS }) {
  return <button className={`${CONTROL_CLASSES} ${VARIANTS[variant]} ${className}`} {...props} />;
}
