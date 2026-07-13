export interface AgentConfig {
  name: string;
  maxSteps: number;
  stepTimeoutMs: number;
  maxRetries: number;
  pauseOnFailure: boolean;
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
  pauseOnFailure: false,
  metadata: {},
  eventsBasePath: "./.frogcode/events/",
};

export function createAgentConfig(
  opts: Partial<AgentConfig> & { name: string },
): AgentConfig {
  return {
    name: opts.name,
    maxSteps: opts.maxSteps ?? DEFAULT_AGENT_CONFIG.maxSteps,
    stepTimeoutMs: opts.stepTimeoutMs ?? DEFAULT_AGENT_CONFIG.stepTimeoutMs,
    maxRetries: opts.maxRetries ?? DEFAULT_AGENT_CONFIG.maxRetries,
    pauseOnFailure: opts.pauseOnFailure ?? DEFAULT_AGENT_CONFIG.pauseOnFailure,
    metadata: opts.metadata ?? { ...DEFAULT_AGENT_CONFIG.metadata },
    eventsBasePath: opts.eventsBasePath ?? DEFAULT_AGENT_CONFIG.eventsBasePath,
    retryableErrorClassifier: opts.retryableErrorClassifier,
  };
}
