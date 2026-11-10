/** Thrown when the API answers with an error status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Calls the HTTP API and returns its JSON. Vite proxies /api to the API server.
 * On an error status, throws an ApiError carrying the API's own message.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(response.status, body?.error ?? `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

/**
 * The HTTP API, one method per HTTP verb. Paths are relative to the API root,
 * like "/runs", and `T` is the response type from @ratchet/api/types. Errors
 * throw an ApiError.
 */
export const api = {
  /** Fetches a path and returns its JSON. */
  get: <T>(path: string) => request<T>(path),
  /** Sends `body` as JSON and returns the JSON response. */
  post: <T>(path: string, body: unknown) =>
    request<T>(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
};
