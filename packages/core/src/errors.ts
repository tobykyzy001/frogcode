import {
  AgentAbortedError,
  NoExecutionToResumeError,
  StepTimeoutError,
} from "./execution-loop.js";
import { InvalidStateTransitionError } from "./state-machine.js";

// StepTimeoutError is retryable only on the first attempt (1-based)
const STEP_TIMEOUT_MAX_RETRY_ATTEMPT = 1;

/**
 * Classifies whether an error is retryable based on its type and attempt count.
 *
 * Retryable (transient, non-deterministic):
 *   - Generic Error (default — preserves existing retry behavior)
 *   - StepTimeoutError on first attempt (occasional timeout)
 *
 * Non-retryable (deterministic, retry won't help):
 *   - Programming errors: TypeError / ReferenceError / SyntaxError / RangeError
 *   - Control flow: AgentAbortedError / NoExecutionToResumeError
 *   - State machine logic: InvalidStateTransitionError
 *   - Persistent StepTimeoutError (attempt >= 2)
 *
 * Implementation note: classes are referenced directly via `instanceof` inside
 * the function body rather than via a pre-built array. This is required because
 * `errors.ts` and `execution-loop.ts` form a circular ESM dependency — class
 * bindings are live references that are only fully resolved at call time, not
 * at module-evaluation time when a top-level array would be populated.
 */
export function isRetryableError(error: unknown, attempt: number): boolean {
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
  // Default: generic errors are retryable
  return true;
}
