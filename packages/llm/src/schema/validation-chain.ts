import type { SchemaValidator, ValidationError } from "./types.js";

function deepClone<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface ValidationChainOptions {
  validator: SchemaValidator;
  maxAttempts: number;
}

/**
 * Structural marker for errors that have exhausted all retry attempts.
 *
 * Defined locally here (rather than imported from `@frogcode/core` or the
 * sibling `../errors/index.js`) so the schema layer stays self-contained and
 * does not race against parallel tasks. TypeScript's structural typing means
 * any value with `readonly retryExhausted: true` satisfies this shape, so a
 * future core `isRetryExhausted` will recognise `ValidationExhaustedError`
 * instances without further changes.
 */
export interface RetryExhaustedMarker {
  readonly retryExhausted: true;
}

/**
 * Thrown by {@link ValidationChain.validateWithRetry} when every attempt has
 * been consumed without producing a valid value. Carries the last set of
 * validation errors so callers (e.g. the state machine) can surface them.
 */
export class ValidationExhaustedError
  extends Error
  implements RetryExhaustedMarker
{
  readonly retryExhausted = true as const;

  constructor(
    public readonly lastErrors: ValidationError[],
    public readonly attempts: number,
  ) {
    super(
      `Schema validation failed after ${attempts} attempt(s); ${lastErrors.length} error(s) on last attempt`,
    );
    this.name = "ValidationExhaustedError";
  }
}

/**
 * Retry orchestrator for schema validation. On invalid input, calls the
 * caller-provided `retryFn` (typically an LLM re-prompt) with the last set
 * of errors and retries until `maxAttempts` is exhausted. Exhaustion throws
 * {@link ValidationExhaustedError} — validation failure is never silently
 * skipped (user decision: direct to state machine `failed`).
 */
export class ValidationChain {
  private readonly validator: SchemaValidator;
  private readonly maxAttempts: number;

  constructor(options: ValidationChainOptions) {
    this.validator = options.validator;
    this.maxAttempts = options.maxAttempts;
  }

  async validateWithRetry(
    data: unknown,
    retryFn: (errors: ValidationError[]) => Promise<unknown>,
  ): Promise<unknown> {
    let current: unknown = deepClone(data);
    let lastErrors: ValidationError[] = [];
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const result = this.validator.validate(current);
      if (result.valid) {
        return result.data;
      }
      lastErrors = result.errors;
      if (attempt < this.maxAttempts) {
        current = deepClone(await retryFn(result.errors));
      }
    }
    throw new ValidationExhaustedError(lastErrors, this.maxAttempts);
  }
}
