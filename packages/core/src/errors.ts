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
 *   - StepTimeoutError on first attempt (occasional timeout)
 *
 * Non-retryable (deterministic, retry won't help):
 *   - Default: unknown errors (could be credits/permission/config issues) — fail fast
 *   - Programming errors: TypeError / ReferenceError / SyntaxError / RangeError
 *   - Control flow: AgentAbortedError / NoExecutionToResumeError
 *   - State machine logic: InvalidStateTransitionError
 *   - Persistent StepTimeoutError (attempt >= 2)
 *
 * Only explicitly known transient errors are retryable. Unknown errors
 * (which could be "insufficient credits", "no permission", etc.) are
 * non-retryable by default — caller should see them immediately.
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
  // Default: unknown errors are non-retryable (could be credits/permission/config)
  return false;
}
