/**
 * Adds query parameters to a path, leaving out empty ones (undefined, null or
 * ""), so optional parameters can be passed straight through.
 */
export function assembleUrl(
  path: string,
  params: Record<string, string | number | boolean | undefined | null>,
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") query.append(key, String(value));
  }
  const search = query.toString();
  return search ? `${path}?${search}` : path;
}
