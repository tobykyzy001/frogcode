/**
 * Sandbox type definitions: result shape + error classes.
 *
 * The ForkSandbox returns a `SandboxResult<T>` containing either a successful
 * output or a structured `SandboxErrorInfo` describing the failure. The
 * `SandboxError` class hierarchy is exported so consumers that prefer
 * throwing typed errors can do so; ForkSandbox itself returns plain JSON.
 */

export interface SandboxResult<T = unknown> {
  success: boolean;
  output?: T;
  error?: SandboxErrorInfo;
}

/**
 * Plain, JSON-serializable description of a sandbox failure. Mirrors the
 * `SandboxError` class hierarchy but is safe to send across the IPC channel.
 */
export interface SandboxErrorInfo {
  name: string;
  message: string;
  code?: string;
  exitCode?: number;
  signal?: string;
  timeoutMs?: number;
  maxMemoryMB?: number;
}

/**
 * Base class for all sandbox-related errors. Consumers that prefer typed
 * `try/catch` blocks can throw subclasses of this; ForkSandbox does not throw
 * these internally — it returns them as `SandboxErrorInfo`.
 */
export abstract class SandboxError extends Error {
  abstract readonly code: string;
}

/**
 * Thrown when a tool exceeds its configured wall-clock timeout.
 *
 * The parent sends SIGTERM (immediate kill on Windows where POSIX signals
 * do not exist) followed by SIGKILL after a 5s grace period.
 */
export class ToolTimeoutError extends SandboxError {
  readonly code = "TOOL_TIMEOUT";
  readonly timeoutMs: number;

  constructor(timeoutMs: number, message?: string) {
    super(message ?? `Tool timed out after ${timeoutMs}ms`);
    this.name = "ToolTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when a tool exceeds its configured V8 heap limit
 * (`--max-old-space-size=N`). V8 aborts the process with exit code 134
 * (SIGABRT) when this happens.
 */
export class ToolMemoryError extends SandboxError {
  readonly code = "TOOL_MEMORY";
  readonly maxMemoryMB: number;

  constructor(maxMemoryMB: number, message?: string) {
    super(message ?? `Tool exceeded memory limit of ${maxMemoryMB}MB`);
    this.name = "ToolMemoryError";
    this.maxMemoryMB = maxMemoryMB;
  }
}

/**
 * Thrown when the sandboxed child process exits abnormally without sending
 * a structured response — e.g. uncaught exception, segfault, or V8 abort.
 */
export class ToolCrashError extends SandboxError {
  readonly code = "TOOL_CRASH";
  readonly exitCode: number | null;
  readonly signal: string | null;

  constructor(
    exitCode: number | null,
    signal: string | null,
    message?: string,
  ) {
    super(
      message ?? `Tool crashed with exit code ${exitCode}, signal ${signal}`,
    );
    this.name = "ToolCrashError";
    this.exitCode = exitCode;
    this.signal = signal;
  }
}
