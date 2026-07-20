import {
  AgentAbortedError,
  NoExecutionToResumeError,
  StepTimeoutError,
} from "./execution-loop.js";
import { InvalidStateTransitionError } from "./state-machine.js";

// StepTimeoutError is retryable only on the first attempt (1-based)
const STEP_TIMEOUT_MAX_RETRY_ATTEMPT = 1;

/**
 * Marker interface indicating that all retries have been exhausted and the
 * error must NOT be retried again. Attach to any error via
 * `Object.assign(err, { retryExhausted: true })` to short-circuit retry loops.
 */
export interface RetryExhaustedMarker {
  readonly retryExhausted: true;
}

/**
 * Returns true if the given value carries the RetryExhausted marker.
 * Uses structural typing — no class inheritance required.
 */
export function isRetryExhausted(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as Record<string, unknown>).retryExhausted === true
  );
}

/**
 * Classifies whether an error is retryable based on its type and attempt count.
 *
 * Retryable (transient, non-deterministic):
 *   - StepTimeoutError on first attempt (occasional timeout)
 *
 * Non-retryable (deterministic, retry won't help):
 *   - Default: unknown errors (could be credits/permission/config issues) — fail fast
 *   - Programming errors: TypeError / ReferenceError / SyntaxError / RangeError
 *   - Control flow: AgentAbortedError / NoExecutionToResumeError
 *   - State machine logic: InvalidStateTransitionError
 *   - Persistent StepTimeoutError (attempt >= 2)
 *   - Any error carrying the RetryExhaustedMarker (explicit "give up" signal)
 *
 * Only explicitly known transient errors are retryable. Unknown errors
 * (which could be "insufficient credits", "no permission", etc.) are
 * non-retryable by default — caller should see them immediately.
 */
export function isRetryableError(error: unknown, attempt: number): boolean {
  // RetryExhausted marker: explicit "do not retry" signal — checked FIRST
  if (isRetryExhausted(error)) {
    return false;
  }
  // StepTimeoutError: retryable only on first attempt
  if (error instanceof StepTimeoutError) {
    return attempt <= STEP_TIMEOUT_MAX_RETRY_ATTEMPT;
  }
  // Non-retryable built-in programming errors
  if (
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError ||
    error instanceof RangeError
  ) {
    return false;
  }
  // Non-retryable framework errors (control flow / state machine logic)
  if (
    error instanceof AgentAbortedError ||
    error instanceof NoExecutionToResumeError ||
    error instanceof InvalidStateTransitionError
  ) {
    return false;
  }
  // Default: unknown errors are non-retryable (could be credits/permission/config)
  return false;
}
