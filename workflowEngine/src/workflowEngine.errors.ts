/**
 * Thrown by a step to fail for good, without retries: for a decision, such as
 * "insufficient funds", rather than a glitch that might pass, such as a timeout.
 * Any other error is retried while the step has attempts left.
 */
export class NonRetryableError extends Error {
  override name = "NonRetryableError";
}
