export interface AgentConfig {
  name: string;
  maxSteps: number;
  stepTimeoutMs: number;
  maxRetries: number;
  metadata: Record<string, unknown>;
  eventsBasePath: string;
  /**
   * Optional override for retryable-error classification.
   * When omitted, the built-in `isRetryableError` is used.
   */
  retryableErrorClassifier?: (error: unknown, attempt: number) => boolean;
}

export const DEFAULT_AGENT_CONFIG: Omit<AgentConfig, "name"> = {
  maxSteps: 10,
  stepTimeoutMs: 30000,
  maxRetries: 3,
  metadata: {},
  eventsBasePath: "./.frogcode/events/",
};

export function createAgentConfig(
  opts: Partial<AgentConfig> & { name: string },
): AgentConfig {
  const maxRetries = opts.maxRetries ?? DEFAULT_AGENT_CONFIG.maxRetries;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error(
      `Invalid maxRetries: ${maxRetries}. Must be a non-negative integer.`,
    );
  }

  return {
    name: opts.name,
    maxSteps: opts.maxSteps ?? DEFAULT_AGENT_CONFIG.maxSteps,
    stepTimeoutMs: opts.stepTimeoutMs ?? DEFAULT_AGENT_CONFIG.stepTimeoutMs,
    maxRetries,
    metadata: opts.metadata ?? { ...DEFAULT_AGENT_CONFIG.metadata },
    eventsBasePath: opts.eventsBasePath ?? DEFAULT_AGENT_CONFIG.eventsBasePath,
    retryableErrorClassifier: opts.retryableErrorClassifier,
  };
}
