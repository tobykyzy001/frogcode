export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  backoffFactor: number;
  maxDelayMs: number;
  retryableStatuses: number[];
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 1000,
  backoffFactor: 2,
  maxDelayMs: 30000,
  retryableStatuses: [429, 503, 500],
};
