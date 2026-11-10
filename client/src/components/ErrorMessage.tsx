import type { ComponentProps } from "react";

/** A red message, such as a failed request. */
export function ErrorMessage(props: ComponentProps<"p">) {
  return <p className="my-3.5 text-red" {...props} />;
}
