/**
 * ToolPipeline — orchestrates ToolRegistry + PermissionEngine + sandbox
 * into a single call flow.
 *
 * Full call flow:
 *   1. Lookup tool in registry → ToolNotFoundError if missing
 *   2. Validate input with Zod inputSchema → ValidationError if invalid
 *   3. Permission check → PermissionDeniedError if denied
 *   4. Execute tool with timeout/memory protection → SandboxError on failure
 *   5. Validate output with Zod outputSchema → OutputValidationError if invalid
 *   6. Return ToolResultEntry (success or structured error)
 *
 * IMPORTANT: All errors are returned as structured `ToolResultEntry` objects,
 * NOT thrown to the caller. The LLM must see the error and be able to retry
 * with different params. The outer `try/catch` around `execute` is the DESIGN
 * PATTERN, not a fallback: it's how tool failures are communicated back to the
 * LLM so the model can react and retry.
 *
 * DESIGN DECISION — sandbox vs. direct execution:
 * The plan says "ForkSandbox.run(tool.execute, input, ...)". But
 * `ForkSandbox.run(script: string, input)` takes a JS SOURCE STRING (sent to a
 * child process via IPC), and `tool.execute` is a CLOSURE that cannot be
 * serialized across the process boundary.
 *
 * For Phase 3 MVP, the pipeline executes `tool.execute` DIRECTLY in the
 * parent process, with timeout protection via `AbortController` + `Promise.
 * race` (so the pipeline returns promptly even if the tool ignores the
 * signal). The `sandbox` instance is held in the constructor (so callers
 * can wire it up and tests can verify the contract) but is NOT used by
 * default. Tools that need true process isolation will opt in via a
 * `sandboxed: true` tag in a future task. This is acceptable because built-in
 * tools (fs/shell/http/search) use Node APIs that don't crash the process;
 * ForkSandbox is reserved for tools that run arbitrary user code (none in
 * Phase 3). See `.sisyphus/plans/phase3-tool-system.md` Task 8 for context.
 */

import type { ToolResultEntry, ToolResultError } from "./bridge.js";
import type { ToolContext } from "./context.js";
import type { ToolDefinition } from "./definition.js";
import type { PermissionEngine } from "./permission/engine.js";
import type { PermissionCheckResult } from "./permission/types.js";
import type { ToolRegistry } from "./registry.js";
import type { ForkSandbox } from "./sandbox/fork-sandbox.js";
import { ToolTimeoutError } from "./sandbox/types.js";

/**
 * Minimal structural view of `PermissionEngine` — only `check` is needed.
 * Declared as a structural type so both the real `PermissionEngine` and the
 * test mock (`createMockPermissionEngine`) satisfy this interface without
 * having to implement every public method of the class.
 */
export type PermissionChecker = Pick<PermissionEngine, "check">;

/**
 * Minimal structural view of `ForkSandbox` — only `run` is needed. Reserved
 * for future opt-in sandboxing; not invoked by the pipeline today.
 */
export type SandboxRunner = Pick<ForkSandbox, "run">;

/**
 * LLM-side tool call request. Matches OpenAI/Anthropic `tool_call` shape.
 *
 * Defined locally (rather than imported from `@frogcode/llm`) so the tools
 * package has no runtime dependency on the LLM package, and accepts a
 * slightly looser `arguments: unknown` (the LLM-side type uses
 * `Record<string, unknown>`; the pipeline validates the raw value via
 * `inputSchema` before use).
 */
export interface ToolCall {
  /** LLM-assigned call id (e.g. "call_abc123"). Correlates result back to call. */
  readonly id: string;
  /** Tool id (e.g. "fs.read") — must be registered in the registry. */
  readonly name: string;
  /** Raw arguments from LLM — will be validated by `tool.inputSchema`. */
  readonly arguments: unknown;
}

export interface ToolHooks {
  onToolStart?: (call: ToolCall) => void;
  onToolEnd?: (call: ToolCall, result: ToolResultEntry) => void;
  onToolError?: (call: ToolCall, error: ToolResultError) => void;
}

export interface ToolPipelineOptions {
  registry: ToolRegistry;
  permission: PermissionChecker;
  /**
   * Sandbox instance — currently NOT used for built-in tools (they execute
   * in the parent process with `AbortController`-based timeout). Reserved
   * for future tools that opt into process isolation via
   * `tags: ["sandboxed"]`. Required by the constructor per spec so callers
   * wire it up explicitly (even if unused today).
   */
  sandbox: SandboxRunner;
  hooks?: ToolHooks;
}

/**
 * Base class for tool-pipeline error subclasses. Mirrors the shape of
 * `SandboxError` (in `sandbox/types.ts`): `name` set in constructor, `code`
 * as a readonly field. The pipeline does NOT throw these — it returns
 * structured `ToolResultError` objects — but the classes exist so that:
 *   1. Tools that wish to signal a specific failure category can throw them
 *      (the pipeline's `classifyError` preserves the type info).
 *   2. Consumers can use `instanceof` checks when re-throwing or logging.
 *   3. Tests can construct them directly to verify the structured shape.
 *
 * Existing classes that pre-date this module are part of the same conceptual
 * family but have their own base classes:
 *   - `ToolNotFoundError` (in `registry.ts`) extends `Error`
 *   - `ToolTimeoutError` / `ToolMemoryError` / `ToolCrashError`
 *     (in `sandbox/types.ts`) extend `SandboxError`
 * They are NOT retroactively made to extend `ToolError`. The pipeline's
 * `classifyError` recognizes them via `name` checks (so they survive
 * structured clone / IPC boundaries if they ever cross one).
 */
export abstract class ToolError extends Error {
  abstract readonly code: string;
}

/** Caller-supplied permission callback denied the call. */
export class PermissionDeniedError extends ToolError {
  readonly code = "PERMISSION_DENIED";
  readonly reason?: string;
  constructor(message: string, reason?: string) {
    super(message);
    this.name = "PermissionDeniedError";
    this.reason = reason;
  }
}

/** Input failed Zod `inputSchema` validation. */
export class ValidationError extends ToolError {
  readonly code = "INPUT_VALIDATION_FAILED";
  readonly issues: ReadonlyArray<{ path: ReadonlyArray<string | number> }>;
  constructor(
    message: string,
    issues: ReadonlyArray<{ path: ReadonlyArray<string | number> }>,
  ) {
    super(message);
    this.name = "ValidationError";
    this.issues = issues;
  }
}

/** Tool returned a value that failed `outputSchema` validation. */
export class OutputValidationError extends ToolError {
  readonly code = "OUTPUT_VALIDATION_FAILED";
  readonly issues: ReadonlyArray<{ path: ReadonlyArray<string | number> }>;
  constructor(
    message: string,
    issues: ReadonlyArray<{ path: ReadonlyArray<string | number> }>,
  ) {
    super(message);
    this.name = "OutputValidationError";
    this.issues = issues;
  }
}

/**
 * Orchestrates the full tool call flow for a single LLM tool_call. Always
 * returns a structured `ToolResultEntry` — never throws to the caller.
 *
 * Flow:
 *   1. Lookup tool in registry → `ToolNotFoundError` if missing
 *   2. Validate input with Zod `inputSchema` → `ValidationError` if invalid
 *   3. Permission check → `PermissionDeniedError` if denied
 *   4. Execute tool with `AbortController`-based timeout
 *      → `ToolTimeoutError` / `ToolMemoryError` / `ToolCrashError` on failure
 *   5. Validate output with Zod `outputSchema` → `OutputValidationError`
 *   6. Return `ToolResultEntry` (success or structured error — NEVER throws)
 */
export class ToolPipeline {
  private readonly registry: ToolRegistry;
  private readonly permission: PermissionChecker;
  private readonly sandbox: SandboxRunner;
  private readonly hooks?: ToolHooks;

  constructor(opts: ToolPipelineOptions) {
    this.registry = opts.registry;
    this.permission = opts.permission;
    this.sandbox = opts.sandbox;
    this.hooks = opts.hooks;
  }

  /**
   * Execute a single tool call. Always resolves to a `ToolResultEntry` —
   * never rejects. Hooks fire in this order: `onToolStart` → `onToolEnd`
   * (always) and `onToolError` (only when `result.success === false`).
   * Caller-supplied hook bugs (throwing inside a hook) propagate — those are
   * caller errors, not tool errors.
   */
  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResultEntry> {
    this.hooks?.onToolStart?.(call);
    const result = await this.executeInternal(call, ctx);
    this.hooks?.onToolEnd?.(call, result);
    if (!result.success && result.error) {
      this.hooks?.onToolError?.(call, result.error);
    }
    return result;
  }

  /**
   * Execute multiple tool calls concurrently via `Promise.all`. Returns one
   * `ToolResultEntry` per call, in the same order as the input array. An
   * empty input returns an empty array. Each call's hooks fire independently
   * (concurrent calls may interleave hook callbacks).
   */
  async executeBatch(
    calls: readonly ToolCall[],
    ctx: ToolContext,
  ): Promise<ToolResultEntry[]> {
    return Promise.all(calls.map((call) => this.execute(call, ctx)));
  }

  private async executeInternal(
    call: ToolCall,
    ctx: ToolContext,
  ): Promise<ToolResultEntry> {
    // Step 1: Lookup tool in registry
    const tool = this.registry.get(call.name);
    if (!tool) {
      // Construct the structured error directly: the registry's
      // `ToolNotFoundError` class (in registry.ts) has no `code` field, but
      // the LLM-facing `ToolResultError` should include `code: "TOOL_NOT_FOUND"`
      // so callers can branch on it without parsing `name`.
      return {
        toolCallId: call.id,
        toolName: call.name,
        success: false,
        error: {
          name: "ToolNotFoundError",
          message: `Tool "${call.name}" is not registered`,
          code: "TOOL_NOT_FOUND",
        },
      };
    }

    // Step 2: Validate input with Zod
    const inputParse = tool.inputSchema.safeParse(call.arguments);
    if (!inputParse.success) {
      return {
        toolCallId: call.id,
        toolName: tool.id,
        success: false,
        error: {
          name: "ValidationError",
          message: `Input validation failed: ${inputParse.error.message}`,
          code: "INPUT_VALIDATION_FAILED",
        },
      };
    }
    const input = inputParse.data;

    // Step 3: Permission check
    const permResult: PermissionCheckResult = await this.permission.check(
      tool,
      input,
      ctx,
    );
    if (!permResult.allowed) {
      return {
        toolCallId: call.id,
        toolName: tool.id,
        success: false,
        error: {
          name: "PermissionDeniedError",
          message: permResult.reason ?? "Permission denied",
          code: "PERMISSION_DENIED",
        },
      };
    }

    // Steps 4–6: Execute (with timeout) → validate output → return result.
    // The try/catch here is the DESIGN PATTERN, not a fallback: it converts
    // tool failures (timeout, memory, crash, thrown error) into structured
    // `ToolResultEntry` objects for the LLM.
    try {
      const output = await this.executeWithTimeout(tool, input, ctx);

      // Step 5: Validate output with Zod
      const outputParse = tool.outputSchema.safeParse(output);
      if (!outputParse.success) {
        return {
          toolCallId: call.id,
          toolName: tool.id,
          success: false,
          error: {
            name: "OutputValidationError",
            message: `Output validation failed: ${outputParse.error.message}`,
            code: "OUTPUT_VALIDATION_FAILED",
          },
        };
      }

      // Step 6: Success
      return {
        toolCallId: call.id,
        toolName: tool.id,
        success: true,
        output: outputParse.data,
      };
    } catch (err) {
      return {
        toolCallId: call.id,
        toolName: tool.id,
        success: false,
        error: classifyError(err),
      };
    }
  }

  /**
   * Race `tool.execute` against a wall-clock timeout. On timeout:
   *   - abort the `AbortSignal` (so tools that respect it can stop early)
   *   - reject the race with `ToolTimeoutError` (so the pipeline returns
   *     promptly even if the tool ignores the signal)
   *
   * Limitation: tools that ignore `abortSignal` will keep running in the
   * background after timeout. The pipeline still returns a timeout error to
   * the LLM promptly; the orphaned promise resolves/rejects silently. This
   * is acceptable for Phase 3 (built-in tools either respect abort or are
   * fast enough not to need it). True process-level kill requires
   * ForkSandbox, which is wired but not used by default.
   */
  private async executeWithTimeout<I, O>(
    tool: ToolDefinition<I, O>,
    input: I,
    ctx: ToolContext,
  ): Promise<O> {
    const ac = new AbortController();
    const ctxWithSignal: ToolContext = { ...ctx, abortSignal: ac.signal };
    const timeoutMs = tool.timeoutMs;

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        ac.abort();
        reject(new ToolTimeoutError(timeoutMs));
      }, timeoutMs);
    });

    try {
      return await Promise.race([
        tool.execute(input, ctxWithSignal),
        timeoutPromise,
      ]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }
}

/**
 * Map a thrown value to a `ToolResultError`. Recognizes the `SandboxError`
 * family by `name` (so errors thrown by tools that reuse those classes
 * surface with the right `code`), the `AbortError` produced by
 * `AbortController`-aware APIs (categorized as timeout), and the
 * pipeline-local `ToolError` subclasses by `instanceof`.
 *
 * Generic `Error` instances are wrapped as `ToolCrashError` so every
 * structured error carries a `code` field — this lets LLM-side retry logic
 * branch on `code` rather than parsing free-form `name` strings. The
 * original `message` survives verbatim.
 *
 * Non-Error throws (string, number, plain object) are also categorized as
 * `ToolCrashError` with a synthesized message.
 */
function classifyError(err: unknown): ToolResultError {
  if (err instanceof Error) {
    // AbortError (from tools that respect abortSignal and throw on abort)
    // → categorize as timeout.
    if (err.name === "AbortError") {
      return {
        name: "ToolTimeoutError",
        message: err.message || "Tool execution was aborted (timeout)",
        code: "TOOL_TIMEOUT",
      };
    }
    // Pre-existing sandbox error classes — preserve name + synthesize code.
    if (err.name === "ToolTimeoutError") {
      return {
        name: "ToolTimeoutError",
        message: err.message,
        code: "TOOL_TIMEOUT",
      };
    }
    if (err.name === "ToolMemoryError") {
      return {
        name: "ToolMemoryError",
        message: err.message,
        code: "TOOL_MEMORY",
      };
    }
    if (err.name === "ToolCrashError") {
      return {
        name: "ToolCrashError",
        message: err.message,
        code: "TOOL_CRASH",
      };
    }
    // Pipeline-local ToolError subclasses (ValidationError,
    // OutputValidationError, PermissionDeniedError). Use `instanceof` so
    // the structured `code` field is preserved exactly.
    if (err instanceof ToolError) {
      return {
        name: err.name,
        message: err.message,
        code: err.code,
      };
    }
    // Generic Error thrown by the tool — wrap as ToolCrashError so the
    // structured result has a consistent `code` field for LLM retry logic.
    return {
      name: "ToolCrashError",
      message: err.message,
      code: "TOOL_CRASH",
    };
  }
  // Non-Error thrown (string, number, plain object, etc.) — treat as crash.
  return {
    name: "ToolCrashError",
    message: `Tool threw non-Error value: ${String(err)}`,
    code: "TOOL_CRASH",
  };
}
