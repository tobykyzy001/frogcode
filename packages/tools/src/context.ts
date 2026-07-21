export interface ToolLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface ToolContext {
  sandbox?: unknown;
  permission?: unknown;
  abortSignal?: AbortSignal;
  logger?: ToolLogger;
  workingDirectory?: string;
}
