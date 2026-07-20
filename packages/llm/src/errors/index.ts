/**
 * Structural marker used to detect that an error has exhausted all retry attempts.
 *
 * Defined locally here (rather than imported from `@frogcode/core`) so this
 * package does not race against the parallel core task that also adds it.
 * TypeScript's structural typing means any value with `readonly retryExhausted: true`
 * satisfies this shape, so a future core `isRetryExhausted` will recognise
 * `LLMRetryExhaustedError` instances without further changes.
 */
export interface RetryExhaustedMarker {
  readonly retryExhausted: true;
}

export class LLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMError";
  }
}

export interface RateLimitErrorOptions {
  retryAfter?: number;
}

export class RateLimitError extends LLMError {
  readonly retryAfter?: number;

  constructor(message: string, options: RateLimitErrorOptions = {}) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfter = options.retryAfter;
  }
}

export class NetworkError extends LLMError {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

export class AbortedError extends LLMError {
  constructor(message: string) {
    super(message);
    this.name = "AbortedError";
  }
}

export interface InvalidResponseErrorOptions {
  raw?: unknown;
}

export class InvalidResponseError extends LLMError {
  readonly raw?: unknown;

  constructor(message: string, options: InvalidResponseErrorOptions = {}) {
    super(message);
    this.name = "InvalidResponseError";
    this.raw = options.raw;
  }
}

export class UnsupportedError extends LLMError {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedError";
  }
}

export class LLMRetryExhaustedError
  extends LLMError
  implements RetryExhaustedMarker
{
  readonly retryExhausted = true as const;

  constructor(
    public readonly lastError: unknown,
    public readonly attempts: number,
  ) {
    const inner =
      lastError instanceof Error ? lastError.message : String(lastError);
    super(`LLM call failed after ${attempts} attempt(s): ${inner}`);
    this.name = "LLMRetryExhaustedError";
  }
}
