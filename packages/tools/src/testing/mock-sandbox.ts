export interface MockSandboxResult<T> {
  success: boolean;
  output?: T;
  error?: {
    name: string;
    message: string;
    timeoutMs?: number;
    exitCode?: number;
  };
}

export interface MockSandboxConfig {
  defaultOutput?: unknown;
  error?: Error;
  delayMs?: number;
  failWithTimeout?: boolean;
  failWithCrash?: boolean;
}

export interface ForkSandboxLike {
  run<T = unknown>(
    script: string,
    input: unknown,
  ): Promise<MockSandboxResult<T>>;
}

export function createMockSandbox(
  config: MockSandboxConfig = {},
): ForkSandboxLike {
  return {
    async run<T>(
      _script: string,
      _input: unknown,
    ): Promise<MockSandboxResult<T>> {
      if (config.delayMs && config.delayMs > 0) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, config.delayMs),
        );
      }
      if (config.failWithTimeout) {
        return {
          success: false,
          error: {
            name: "ToolTimeoutError",
            message: "sandbox timed out",
            timeoutMs: 60000,
          },
        };
      }
      if (config.failWithCrash) {
        return {
          success: false,
          error: {
            name: "ToolCrashError",
            message: "child process crashed",
            exitCode: 1,
          },
        };
      }
      if (config.error) {
        return {
          success: false,
          error: {
            name: config.error.name,
            message: config.error.message,
          },
        };
      }
      return {
        success: true,
        output: (config.defaultOutput ?? ({ ok: true } as unknown)) as T,
      };
    },
  };
}
