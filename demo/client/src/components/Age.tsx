import { useNow } from "../hooks/useNow";
import { formatAge } from "../utils/format";

/** Ages are shown to the second ("12s ago"), so they tick once a second. */
const AGE_TICK_MS = 1000;

/** How long ago something happened, like "5m ago", kept up to date. */
export function Age({ at }: { at: string | null }) {
  const now = useNow(AGE_TICK_MS);
  return formatAge({ at, now });
}
