import {
  LLMRetryExhaustedError,
  NetworkError,
  RateLimitError,
} from "../errors/index.js";
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "./policy.js";

/**
 * Executes `fn` with retry semantics defined by `policy`.
 *
 * Retryable errors:
 *   - `RateLimitError` with `retryAfter` → wait `retryAfter * 1000` ms (no jitter)
 *   - `RateLimitError` without `retryAfter` → exponential backoff with ±20% jitter
 *   - `NetworkError` → exponential backoff with ±20% jitter
 *
 * Non-retryable errors (everything else, including `AbortedError`,
 * `InvalidResponseError`, `UnsupportedError`, plain `LLMError`) propagate
 * immediately on the first attempt.
 *
 * When `maxRetries` is exhausted on a retryable error, the last error is
 * wrapped in {@link LLMRetryExhaustedError} (which carries the
 * `retryExhausted: true` marker).
 *
 * The wait between attempts is interruptible: if `signal` aborts during a
 * backoff, the wait rejects with `signal.reason` and that propagates out of
 * `execute` (it is NOT wrapped, NOT retried).
 */
// biome-ignore lint/complexity/noStaticOnlyClass: namespace class for RetryExecutor.execute() API
export class RetryExecutor {
  static async execute<T>(
    fn: () => Promise<T>,
    policy: RetryPolicy = DEFAULT_RETRY_POLICY,
    signal?: AbortSignal,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        const delay = computeDelay(error, policy, attempt);
        // Non-retryable: throw the original error immediately.
        if (delay === null) throw error;
        // Retryable but out of attempts: fall through to exhaustion wrapper.
        if (attempt === policy.maxRetries) break;
        // Wait, then retry. If `signal` aborts during the wait, `sleep`
        // rejects with `signal.reason` and that propagates out verbatim.
        await sleep(delay, signal);
      }
    }
    // `+ 1` because attempt is 0-indexed: maxRetries=3 → 4 total attempts.
    throw new LLMRetryExhaustedError(lastError, policy.maxRetries + 1);
  }
}

/**
 * Returns the delay (in ms) before the next retry, or `null` if the error
 * is not retryable.
 *
 * - `RateLimitError` with `retryAfter` (seconds) → `retryAfter * 1000` ms,
 *   used verbatim (no jitter, no exponential factor).
 * - `RateLimitError` without `retryAfter` → exponential backoff with jitter.
 * - `NetworkError` → exponential backoff with jitter.
 * - Anything else → `null` (caller throws immediately).
 */
function computeDelay(
  error: unknown,
  policy: RetryPolicy,
  attempt: number,
): number | null {
  if (error instanceof RateLimitError) {
    if (typeof error.retryAfter === "number") {
      return error.retryAfter * 1000;
    }
    return exponentialBackoff(policy, attempt);
  }
  if (error instanceof NetworkError) {
    return exponentialBackoff(policy, attempt);
  }
  return null;
}

/**
 * `min(baseDelayMs * backoffFactor^attempt, maxDelayMs)` with ±20% jitter.
 *
 * `Math.random()` ∈ [0, 1) → `jitter` ∈ [-0.2, +0.2) → multiplier ∈ [0.8, 1.2).
 */
function exponentialBackoff(policy: RetryPolicy, attempt: number): number {
  const raw = policy.baseDelayMs * policy.backoffFactor ** attempt;
  const capped = Math.min(raw, policy.maxDelayMs);
  const jitter = Math.random() * 0.4 - 0.2;
  return capped * (1 + jitter);
}

/**
 * Resolves after `ms` milliseconds, but rejects immediately with
 * `signal.reason` if the abort signal is (or becomes) aborted.
 *
 * The abort listener is removed when the timer fires normally, so a normal
 * completion does not leak a listener onto the signal.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // Pre-aborted: reject synchronously. After this check TS narrows `signal`
    // to `AbortSignal` inside the block, so `signal.reason` is safe.
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
