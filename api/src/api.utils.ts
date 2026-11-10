/** A value after JSON serialization: dates become ISO strings. */
export type ToJson<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? ToJson<U>[]
    : T extends object
      ? { [K in keyof T]: ToJson<T[K]> }
      : T;

/**
 * Returns exactly what the client will receive. Assigning the result to a type
 * from api.types.ts makes TypeScript check the response against it.
 */
export function toJson<T>(value: T): ToJson<T> {
  return JSON.parse(JSON.stringify(value)) as ToJson<T>;
}
