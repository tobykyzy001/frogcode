import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InvalidResponseError,
  LLMError,
  LLMRetryExhaustedError,
  NetworkError,
  RateLimitError,
} from "../src/errors/index.js";
import { RetryExecutor } from "../src/retry/executor.js";
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "../src/retry/policy.js";

/**
 * Tight policy used by most tests so backoff numbers are easy to reason about.
 * `retryableStatuses` is unused by the executor (it classifies by error type)
 * but the field is required by the type, so we mirror DEFAULT.
 */
const tightPolicy: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 1000,
  backoffFactor: 2,
  maxDelayMs: 30000,
  retryableStatuses: [429, 503, 500],
};

describe("DEFAULT_RETRY_POLICY", () => {
  it("matches the documented defaults", () => {
    expect(DEFAULT_RETRY_POLICY).toEqual({
      maxRetries: 3,
      baseDelayMs: 1000,
      backoffFactor: 2,
      maxDelayMs: 30000,
      retryableStatuses: [429, 503, 500],
    });
  });
});

describe("RetryExecutor.execute", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Default: no jitter (multiplier = 1.0). Individual jitter tests override.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("succeeds on first try without calling sleep", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await RetryExecutor.execute(fn, tightPolicy);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("uses the default policy when none is passed", async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const result = await RetryExecutor.execute(fn);
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on RateLimitError with retryAfter, waiting retryAfter seconds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RateLimitError("slow down", { retryAfter: 5 }))
      .mockResolvedValueOnce("recovered");
    const promise = RetryExecutor.execute(fn, tightPolicy);

    // Should still be waiting — fn called once, retryAfter=5 means 5000ms.
    await vi.advanceTimersByTimeAsync(4999);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on RateLimitError without retryAfter using exponential backoff", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RateLimitError("slow down"))
      .mockResolvedValueOnce("recovered");
    const promise = RetryExecutor.execute(fn, tightPolicy);

    // baseDelayMs * 2^0 = 1000ms (Math.random=0.5 → no jitter)
    await vi.advanceTimersByTimeAsync(999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on NetworkError with exponential backoff across multiple attempts", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new NetworkError("boom 1"))
      .mockRejectedValueOnce(new NetworkError("boom 2"))
      .mockResolvedValueOnce("ok");
    const promise = RetryExecutor.execute(fn, tightPolicy);

    // attempt 0 fail → backoff = 1000 * 2^0 = 1000
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    // attempt 1 fail → backoff = 1000 * 2^1 = 2000
    await vi.advanceTimersByTimeAsync(2000);
    // attempt 2 succeeds
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry on InvalidResponseError (non-retryable) — throws immediately", async () => {
    const err = new InvalidResponseError("bad json");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(RetryExecutor.execute(fn, tightPolicy)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on a plain LLMError — throws immediately", async () => {
    const err = new LLMError("unexpected");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(RetryExecutor.execute(fn, tightPolicy)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws LLMRetryExhaustedError when retries are exhausted on NetworkError", async () => {
    const fn = vi.fn().mockRejectedValue(new NetworkError("always fails"));
    const promise = RetryExecutor.execute(fn, tightPolicy);
    promise.catch(() => {}); // suppress unhandled-rejection warning during timer advance

    // Drive all 3 backoff waits: 1000 + 2000 + 4000 = 7000ms
    await vi.advanceTimersByTimeAsync(7000);

    await expect(promise).rejects.toMatchObject({
      name: "LLMRetryExhaustedError",
      retryExhausted: true,
      attempts: tightPolicy.maxRetries + 1,
    });
    // 4 total attempts: initial + 3 retries
    expect(fn).toHaveBeenCalledTimes(tightPolicy.maxRetries + 1);
  });

  it("wraps the last error inside LLMRetryExhaustedError", async () => {
    const lastErr = new NetworkError("the final boom");
    const fn = vi.fn().mockRejectedValue(lastErr);
    const promise = RetryExecutor.execute(fn, tightPolicy);
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(7000);
    await expect(promise).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof LLMRetryExhaustedError)) return false;
      return err.lastError === lastErr;
    });
  });

  it("AbortSignal interrupts the wait — rejects with signal reason, no further retry", async () => {
    const ac = new AbortController();
    const abortReason = new Error("user aborted");
    const fn = vi.fn().mockRejectedValue(new NetworkError("transient"));
    const promise = RetryExecutor.execute(fn, tightPolicy, ac.signal);

    // fn threw, sleep started. Abort before the backoff completes.
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(1);
    ac.abort(abortReason);

    await expect(promise).rejects.toBe(abortReason);
    // No further retry happened.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("AbortSignal that is already aborted causes sleep to reject immediately", async () => {
    const ac = new AbortController();
    const abortReason = new Error("pre-aborted");
    ac.abort(abortReason);

    const fn = vi.fn().mockRejectedValue(new NetworkError("transient"));
    const promise = RetryExecutor.execute(fn, tightPolicy, ac.signal);

    // fn threw once, then sleep should reject synchronously since signal is aborted.
    await expect(promise).rejects.toBe(abortReason);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("applies -20% jitter when Math.random returns 0", async () => {
    vi.mocked(Math.random).mockReturnValue(0);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new NetworkError("fail"))
      .mockResolvedValueOnce("ok");
    const promise = RetryExecutor.execute(fn, tightPolicy);

    // base = 1000, jitter = -20% → 800ms
    await vi.advanceTimersByTimeAsync(799);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("applies +20% jitter when Math.random returns 1", async () => {
    vi.mocked(Math.random).mockReturnValue(1);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new NetworkError("fail"))
      .mockResolvedValueOnce("ok");
    const promise = RetryExecutor.execute(fn, tightPolicy);

    // base = 1000, jitter = +20% → 1200ms
    await vi.advanceTimersByTimeAsync(1199);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("respects maxDelayMs cap when exponential backoff would exceed it", async () => {
    vi.mocked(Math.random).mockReturnValue(0.5);
    const cappedPolicy: RetryPolicy = {
      maxRetries: 1,
      baseDelayMs: 10000,
      backoffFactor: 10,
      maxDelayMs: 5000,
      retryableStatuses: [429, 503, 500],
    };
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new NetworkError("fail"))
      .mockResolvedValueOnce("ok");
    const promise = RetryExecutor.execute(fn, cappedPolicy);

    // base = min(10000 * 10^0, 5000) = min(10000, 5000) = 5000
    await vi.advanceTimersByTimeAsync(4999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("RateLimitError with retryAfter is NOT subject to exponential backoff or jitter", async () => {
    // Even with Math.random returning 0 (would normally be -20%), retryAfter is used verbatim.
    vi.mocked(Math.random).mockReturnValue(0);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RateLimitError("slow", { retryAfter: 3 }))
      .mockResolvedValueOnce("ok");
    const promise = RetryExecutor.execute(fn, tightPolicy);

    // 3000ms exactly — jitter should NOT apply to retryAfter path.
    await vi.advanceTimersByTimeAsync(2999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
