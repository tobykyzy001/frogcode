/**
 * ForkSandbox — child_process.fork-based process isolation.
 *
 * Spawns a Node.js child process running `sandbox-worker.mjs`. The script
 * is evaluated in the child and the result is returned via IPC.
 *
 * Failure modes:
 * - Timeout: parent sends SIGTERM (Windows: TerminateProcess), then SIGKILL
 *   after a 5s grace period. Returns `ToolTimeoutError`.
 * - Memory: V8 `--max-old-space-size=N` causes OOM abort (exit code 134).
 *   Returns `ToolMemoryError`.
 * - Crash: child exits with non-zero code (other than 134) without sending
 *   a structured response. Returns `ToolCrashError`.
 * - Worker-reported error: child sends `{ success: false, error: ... }`.
 *   The error info is passed through verbatim.
 *
 * Windows compatibility: `child.kill("SIGTERM")` is emulated by Node as
 * `TerminateProcess` (forceful kill, no signal). Tests on Windows verify
 * exit code handling, not signal semantics.
 */

import { type ChildProcess, fork } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxErrorInfo, SandboxResult } from "./types.js";

export interface ForkSandboxOptions {
  /** Wall-clock timeout in milliseconds. SIGTERM fires when it elapses. */
  timeoutMs: number;
  /** V8 heap limit in MB (`--max-old-space-size`). OOM exits with code 134. */
  maxMemoryMB: number;
  /**
   * Override the worker script path. Defaults to `sandbox-worker.mjs`
   * adjacent to the compiled `fork-sandbox` module (i.e. inside
   * `dist/sandbox/` next to the bundled `dist/index.mjs`).
   *
   * Tests must set this explicitly because vitest loads the source TS
   * directly, so `import.meta.url` points into `src/` rather than `dist/`.
   *
   * In CJS consumers, `import.meta.url` is unavailable; pass an explicit
   * `workerPath` pointing at the package's `dist/sandbox/sandbox-worker.mjs`.
   */
  workerPath?: string;
}

interface WorkerMessage {
  success: boolean;
  output?: unknown;
  error?: SandboxErrorInfo;
}

/** Grace period between SIGTERM and SIGKILL (ignored on Windows). */
const GRACE_PERIOD_MS = 5000;

/**
 * V8 reports `--max-old-space-size` OOM by aborting the process with
 * exit code 134 (SIGABRT). We treat this specifically as `ToolMemoryError`
 * rather than a generic crash.
 */
const V8_OOM_EXIT_CODE = 134;

/**
 * Resolve the default worker path relative to this module.
 *
 * In ESM (the primary distribution), `import.meta.url` points at
 * `dist/index.mjs` (after bundling), so `dirname` is `dist/` and the worker
 * lives at `dist/sandbox/sandbox-worker.mjs`. CJS callers must pass
 * `workerPath` explicitly.
 */
function resolveDefaultWorkerPath(): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    "sandbox",
    "sandbox-worker.mjs",
  );
}

export class ForkSandbox {
  private readonly timeoutMs: number;
  private readonly maxMemoryMB: number;
  private readonly workerPath: string;

  constructor(opts: ForkSandboxOptions) {
    if (opts.timeoutMs <= 0) {
      throw new Error(
        `ForkSandbox: timeoutMs must be positive, got ${opts.timeoutMs}`,
      );
    }
    if (opts.maxMemoryMB <= 0) {
      throw new Error(
        `ForkSandbox: maxMemoryMB must be positive, got ${opts.maxMemoryMB}`,
      );
    }
    this.timeoutMs = opts.timeoutMs;
    this.maxMemoryMB = opts.maxMemoryMB;
    this.workerPath = opts.workerPath ?? resolveDefaultWorkerPath();
  }

  async run<T = unknown>(
    script: string,
    input: unknown,
  ): Promise<SandboxResult<T>> {
    return new Promise<SandboxResult<T>>((resolve) => {
      let settled = false;
      let timeoutFired = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let graceKillHandle: NodeJS.Timeout | undefined;

      const clearTimers = (): void => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
        if (graceKillHandle) {
          clearTimeout(graceKillHandle);
          graceKillHandle = undefined;
        }
      };

      const child: ChildProcess = fork(this.workerPath, [], {
        execArgv: [`--max-old-space-size=${this.maxMemoryMB}`],
        silent: true,
      });

      const settle = (result: SandboxResult<T>): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        try {
          child.kill();
        } catch {
          // Already dead — best-effort kill, ignore.
        }
        resolve(result);
      };

      const onMessage = (msg: WorkerMessage): void => {
        settle(msg as SandboxResult<T>);
      };

      const onExit = (code: number | null, signal: string | null): void => {
        if (settled) return;
        if (timeoutFired) {
          settle({
            success: false,
            error: {
              name: "ToolTimeoutError",
              message: `Tool timed out after ${this.timeoutMs}ms`,
              code: "TOOL_TIMEOUT",
              timeoutMs: this.timeoutMs,
            },
          });
          return;
        }
        if (code === V8_OOM_EXIT_CODE) {
          settle({
            success: false,
            error: {
              name: "ToolMemoryError",
              message: `Tool exceeded memory limit of ${this.maxMemoryMB}MB`,
              code: "TOOL_MEMORY",
              maxMemoryMB: this.maxMemoryMB,
            },
          });
          return;
        }
        settle({
          success: false,
          error: {
            name: "ToolCrashError",
            message: `Tool crashed with exit code ${code}, signal ${signal}`,
            code: "TOOL_CRASH",
            exitCode: code ?? undefined,
            signal: signal ?? undefined,
          },
        });
      };

      const onError = (err: Error): void => {
        settle({
          success: false,
          error: {
            name: "ToolCrashError",
            message: err.message,
            code: "TOOL_CRASH",
          },
        });
      };

      child.on("message", onMessage);
      child.on("exit", onExit);
      child.on("error", onError);

      timeoutHandle = setTimeout(() => {
        timeoutFired = true;
        try {
          child.kill("SIGTERM");
        } catch {
          // Already dead — nothing to terminate.
        }
        graceKillHandle = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Already dead — nothing to terminate.
          }
        }, GRACE_PERIOD_MS);
      }, this.timeoutMs);

      child.send({ toolId: "anonymous", input, script });
    });
  }
}
