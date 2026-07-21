/**
 * shell.exec — execute a shell command via `child_process.spawn`.
 *
 * Design notes:
 * - Uses `spawn` with `shell: true` (NOT `exec`/`execSync`) so the user's
 *   command is parsed by the system shell (`/bin/sh` on POSIX, `cmd.exe` on
 *   Windows). The caller is responsible for escaping; we deliberately do
 *   NOT attempt to defend against shell injection.
 * - stdout / stderr are buffered and truncated to 1MB to avoid OOM on
 *   runaway commands.
 * - Timeout flow: `timeoutMs` fires `SIGTERM`, then `SIGKILL` after a 5s
 *   grace period. On Windows, `SIGTERM` is emulated by Node as
 *   `TerminateProcess` (immediate, no graceful shutdown) — the grace
 *   period is effectively a no-op there.
 * - Non-zero exit code is NOT a tool failure: the result resolves normally
 *   with `exitCode` populated so the LLM can interpret it. A genuine tool
 *   failure is when `spawn` itself cannot start the child (e.g. the shell
 *   binary is missing) — that surfaces as a structured result with
 *   `exitCode = -1` and the spawn error appended to stderr.
 * - Risk classification (`evaluateRisk`) is exported separately so the
 *   permission engine can register `shellRiskRule` as a `ToolSpecificRule`.
 *   Dangerous patterns are checked anywhere in the command (not just at
 *   the start) so that `echo rm -rf / | sh` is still flagged as high-risk.
 */

import { spawn } from "node:child_process";
import { z } from "zod";
import type { ToolContext } from "../context.js";
import { createTool } from "../definition.js";
import type { PermissionCheckResult } from "../permission/types.js";

/** Maximum bytes to retain per stream (stdout / stderr). */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Grace period between SIGTERM and SIGKILL on POSIX. */
const GRACE_PERIOD_MS = 5000;

/** Default per-command timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Readonly command prefixes that are auto-approved (risk = "low").
 * Matched as: exact match, OR prefix followed by a separator (space, `;`,
 * `|`, `&&`). Windows equivalents (`dir`, `type`, `where`) are included so
 * the same rule works cross-platform.
 */
const SAFE_READONLY_PREFIXES: readonly string[] = [
  "ls",
  "cat",
  "grep",
  "find",
  "pwd",
  "echo",
  "dir",
  "type",
  "where",
  "git status",
  "git log",
  "git diff",
  "git branch",
  "git show",
  "node --version",
  "npm --version",
  "pnpm --version",
];

/**
 * Dangerous command patterns that are always denied (risk = "high").
 * These are checked ANYWHERE in the trimmed command (not just at the
 * start) so that payloads like `echo foo ; rm -rf /` are still flagged.
 * The patterns intentionally over-match: a false "high" simply forces the
 * user to confirm, while a false "low" could destroy data.
 */
const DANGEROUS_PATTERNS: readonly RegExp[] = [
  // rm -rf /anything — the leading `/` is enough to flag (covers /, /home, /etc, ...)
  /rm\s+-rf\s+\/\S*/,
  // rm -rf ~, rm -rf ~/..., rm -rf $HOME, rm -rf $HOME/...
  // The trailing `(?:$|[\s/])` ensures we don't match `~abc` (a filename that
  // just starts with `~`) while still matching `~` at end-of-string.
  /rm\s+-rf\s+(?:~|\$HOME)(?:$|[\s/])/,
  // mkfs (any variant: mkfs, mkfs.ext4, mkfs.vfat, ...)
  /\bmkfs\b/,
  // dd ... of=/dev/... (writing to a block device)
  /\bdd\b[\s\S]*?\bof=\/dev\//,
  // fork bomb: :(){ :|:& };:
  /:\s*\(\)\s*\{\s*:\s*\|\s*:&\s*\}\s*;/,
  // chmod -R 777 / (recursive world-writable on root)
  /chmod\s+-R\s+777\s+\//,
  // shutdown / reboot / halt — system power commands
  /\bshutdown\b/,
  /\breboot\b/,
  /\bhalt\b/,
];

export type ShellRisk = "low" | "medium" | "high";

/**
 * Classify a shell command's risk level.
 *
 * - "low":    readonly command (auto-allow).
 * - "medium": anything else (ask).
 * - "high":   destructive command (always deny — cannot be bypassed).
 *
 * Dangerous patterns take priority: a command containing both a destructive
 * fragment and a readonly prefix (e.g. `echo rm -rf /`) is classified as
 * "high" because the destructive fragment could be redirected to a shell.
 *
 * The check is purely syntactic. A determined caller can still craft a
 * destructive command that escapes detection (e.g. by base64-decoding at
 * runtime). The risk classification is a first-line filter, not a sandbox.
 */
export function evaluateRisk(cmd: string): ShellRisk {
  const trimmed = cmd.trim();
  if (trimmed.length === 0) return "medium";

  // Dangerous patterns are checked first and anywhere in the string.
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      return "high";
    }
  }

  // Safe readonly commands: exact match, or prefix followed by a separator.
  for (const safe of SAFE_READONLY_PREFIXES) {
    if (trimmed === safe) return "low";
    if (
      trimmed.startsWith(`${safe} `) ||
      trimmed.startsWith(`${safe};`) ||
      trimmed.startsWith(`${safe}|`) ||
      trimmed.startsWith(`${safe}&&`)
    ) {
      return "low";
    }
  }

  return "medium";
}

/**
 * Input schema for shell.exec. Exported so the risk rule and tests can
 * reference the same shape. Defaults are applied inside `execute` via
 * `parse()` because `createTool` does not coerce input — callers that
 * bypass the pipeline (e.g. tests) may omit defaulted fields.
 */
export const shellInputSchema = z.object({
  cmd: z.string().min(1).describe("Shell command to execute"),
  cwd: z
    .string()
    .describe("Working directory for the command")
    .default(process.cwd()),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .describe("Per-command timeout in ms")
    .default(DEFAULT_TIMEOUT_MS),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe("Additional env vars merged onto process.env"),
});

export const shellOutputSchema = z.object({
  cmd: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number(),
  durationMs: z.number(),
  timedOut: z.boolean(),
  risk: z.enum(["low", "medium", "high"]),
});

export interface ShellExecInput {
  cmd: string;
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
}

export interface ShellExecOutput {
  cmd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  risk: ShellRisk;
}

export const shellExecTool = createTool({
  id: "shell.exec",
  description:
    "Execute a shell command and return stdout, stderr, and exit code. " +
    "Commands are classified by risk: readonly commands (ls, cat, git status) " +
    "are auto-approved; dangerous commands (rm -rf /) are always denied; " +
    "everything else requires confirmation. Non-zero exit code is NOT a " +
    "tool failure — the LLM should inspect exitCode to judge the result.",
  inputSchema: shellInputSchema,
  outputSchema: shellOutputSchema,
  permission: {
    toolId: "shell.exec",
    decision: "ask",
  },
  tags: ["shell", "subprocess"],
  execute: async (
    rawInput: ShellExecInput,
    _ctx: ToolContext,
  ): Promise<ShellExecOutput> => {
    // Apply schema defaults so callers that bypass the pipeline (tests,
    // ad-hoc usage) still get cwd/timeoutMs populated. Without this,
    // `setTimeout(fn, undefined)` fires immediately and kills every
    // command before it can produce output.
    const input = shellInputSchema.parse(rawInput);
    const risk = evaluateRisk(input.cmd);
    const startTime = Date.now();

    return new Promise<ShellExecOutput>((resolve) => {
      let stdoutBuf = Buffer.alloc(0);
      let stderrBuf = Buffer.alloc(0);
      let timedOut = false;
      let settled = false;
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

      const finish = (result: ShellExecOutput): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        resolve(result);
      };

      const child = spawn(input.cmd, {
        cwd: input.cwd,
        env: { ...process.env, ...input.env },
        shell: true,
        windowsHide: true,
      });

      timeoutHandle = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
        } catch {
          // Process may have already exited — best-effort kill, ignore.
        }
        // After the grace period, escalate to SIGKILL. On Windows this is
        // effectively immediate since SIGTERM is emulated as TerminateProcess.
        graceKillHandle = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Process may have already exited — best-effort kill, ignore.
          }
        }, GRACE_PERIOD_MS);

        // Resolve immediately with the buffers captured so far. On Windows
        // with `shell: true`, killing the cmd.exe wrapper does NOT kill the
        // grandchild process (the actual command), so the `close` event can
        // be delayed by minutes (until the grandchild exits on its own).
        // Resolving here ensures the caller gets a timely response.
        finish({
          cmd: input.cmd,
          stdout: stdoutBuf.toString("utf-8"),
          stderr: stderrBuf.toString("utf-8"),
          exitCode: -1,
          durationMs: Date.now() - startTime,
          timedOut: true,
          risk,
        });
      }, input.timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdoutBuf.length >= MAX_OUTPUT_BYTES) return;
        const remaining = MAX_OUTPUT_BYTES - stdoutBuf.length;
        stdoutBuf = Buffer.concat([stdoutBuf, chunk.subarray(0, remaining)]);
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderrBuf.length >= MAX_OUTPUT_BYTES) return;
        const remaining = MAX_OUTPUT_BYTES - stderrBuf.length;
        stderrBuf = Buffer.concat([stderrBuf, chunk.subarray(0, remaining)]);
      });

      child.on("error", (err: Error) => {
        // spawn itself failed (e.g. shell binary missing). This is the
        // structured-failure path: return exitCode = -1 so the LLM sees
        // the spawn error in stderr rather than throwing and crashing
        // the pipeline.
        finish({
          cmd: input.cmd,
          stdout: stdoutBuf.toString("utf-8"),
          stderr: `${stderrBuf.toString("utf-8")}\nspawn error: ${err.message}`,
          exitCode: -1,
          durationMs: Date.now() - startTime,
          timedOut,
          risk,
        });
      });

      child.on(
        "close",
        (code: number | null, signal: NodeJS.Signals | null) => {
          const exitCode = code ?? (signal ? -1 : 0);
          finish({
            cmd: input.cmd,
            stdout: stdoutBuf.toString("utf-8"),
            stderr: stderrBuf.toString("utf-8"),
            exitCode: timedOut ? -1 : exitCode,
            durationMs: Date.now() - startTime,
            timedOut,
            risk,
          });
        },
      );
    });
  },
});

/**
 * Tool-specific permission rule for shell.exec — evaluates command risk.
 *
 * - "low" risk commands are auto-allowed (returns `{ allowed: true }`).
 * - "high" risk commands are always denied (returns `{ allowed: false }`);
 *   this cannot be bypassed by `auto-approve-all` mode or user confirmation
 *   because the engine treats `ToolSpecificRule` results as authoritative.
 * - "medium" risk commands return `null` so the pipeline falls through
 *   to the tool's default permission rule (here: `decision: "ask"`).
 *
 * Register this with `PermissionEngine.registerToolSpecificRule(shellRiskRule)`.
 */
export const shellRiskRule = {
  toolId: "shell.exec",
  evaluate: (
    input: unknown,
    _ctx: ToolContext,
  ): PermissionCheckResult | null => {
    if (typeof input !== "object" || input === null) return null;
    const { cmd } = input as { cmd?: unknown };
    if (typeof cmd !== "string") return null;
    const risk = evaluateRisk(cmd);
    if (risk === "high") {
      return { allowed: false, reason: `Blocked dangerous command: ${cmd}` };
    }
    if (risk === "low") {
      return { allowed: true, reason: "Auto-approved readonly command" };
    }
    return null;
  },
};

export const shellTools: readonly (typeof shellExecTool)[] = [shellExecTool];
