import { useNow } from "../hooks/useNow";
import { formatUntil } from "../utils/format";

/** Times are shown to the second ("in 12s"), so they tick once a second. */
const UNTIL_TICK_MS = 1000;

/** How long until a time, like "in 5m", kept up to date. */
export function Until({ at }: { at: string | null }) {
  const now = useNow(UNTIL_TICK_MS);
  return formatUntil({ at, now });
}
