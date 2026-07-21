/**
 * ToolActHandler — bridges the PRAO execution loop's Act phase with the
 * `ToolPipeline`.
 *
 * The execution loop calls `act(decision, ctx)` with whatever the LLM's
 * `reason()` returned as the decision. When the decision carries `toolCalls`,
 * the handler delegates each call to `pipeline.executeBatch`, which runs them
 * concurrently and returns one `ToolResultEntry` per call (success or
 * structured error — never throws).
 *
 * The handler returns a `ToolActionResult` envelope that the Observe phase
 * consumes:
 *   - `decision`        — the original decision (passed through verbatim so
 *     observe() can read `text` / `done` etc.)
 *   - `toolActResult`   — `{ toolCallsMade, toolResults }` summary
 *
 * DESIGN NOTE — StepRecord generation:
 *   The plan mentions generating `tool_call` / `tool_result` StepRecords.
 *   `ExecutionContext` (in `@frogcode/core`) does NOT expose a step-recording
 *   API today — it only carries agentId/config/metadata/signal. Persisting
 *   StepRecords is the execution loop's responsibility (it has access to the
 *   EventStore). This handler returns structured data that the loop can turn
 *   into StepRecords using the shapes in `bridge.ts`
 *   (`ToolCallStepInput`, `ToolResultStepOutput`). Keeping this handler free
 *   of EventStore coupling makes it trivially testable with a mock pipeline.
 *
 * DESIGN NOTE — no fallback strategies (per AGENTS.md):
 *   `decision: unknown` is intentionally permissive (the core `ActHandler`
 *   contract is `unknown`). When `decision` is null/undefined/non-object or
 *   has no usable `toolCalls` field, the handler returns a well-formed
 *   `ToolActionResult` with `toolCallsMade: false`. That is not a "fallback"
 *   — it is the documented behavior for "the LLM did not request any tool
 *   calls this turn", which is a normal and expected case for any
 *   tool-calling agent.
 */

import type { ActHandler, ExecutionContext } from "@frogcode/core";
import type { ToolActResult, ToolResultEntry } from "./bridge.js";
import type { ToolContext } from "./context.js";
import type { ToolCall, ToolPipeline } from "./pipeline.js";

/**
 * Shape of the LLM decision passed to `act()`.
 *
 * The LLM's `reason()` returns a `ReasonResult { action, done }`. In Phase 3
 * the `action` (or the decision directly, depending on how T15 wires things)
 * is shaped as `ToolDecision`: an optional `toolCalls` array plus any
 * free-form fields the model emits (e.g. `text` reasoning, `done` flag).
 *
 * Kept intentionally loose (`[key: string]: unknown`) so the handler does not
 * need to know about every LLM-specific extension field — only `toolCalls`
 * and `text` are read by this handler; everything else passes through to the
 * observe phase verbatim via the `decision` field of `ToolActionResult`.
 */
export interface ToolDecision {
  readonly toolCalls?: ReadonlyArray<ToolCall>;
  readonly text?: string;
  readonly [key: string]: unknown;
}

/**
 * Shape of what `act()` returns to the execution loop. The Observe handler
 * receives this as its `result` argument and can use it to feed tool outputs
 * back to the LLM.
 */
export interface ToolActionResult {
  /** The original decision (passed through for observe). */
  readonly decision: ToolDecision;
  /** Tool execution summary (empty when no tool calls were made). */
  readonly toolActResult: ToolActResult;
}

/**
 * Pull a non-empty `toolCalls` array off `decision`, or return `null` when
 * the decision has no usable toolCalls. Treats `null`/`undefined`/non-object
 * decisions and non-array `toolCalls` fields uniformly as "no calls".
 */
function extractToolCalls(decision: unknown): ReadonlyArray<ToolCall> | null {
  if (typeof decision !== "object" || decision === null) return null;
  const candidate = (decision as { toolCalls?: unknown }).toolCalls;
  if (!Array.isArray(candidate) || candidate.length === 0) return null;
  return candidate as ReadonlyArray<ToolCall>;
}

/**
 * Coerce a `decision: unknown` into a `ToolDecision` for the result envelope.
 * Non-object decisions become an empty object — the handler still returns a
 * well-formed `ToolActionResult` so observe() never has to special-case null.
 */
function asToolDecision(decision: unknown): ToolDecision {
  if (typeof decision === "object" && decision !== null) {
    return decision as ToolDecision;
  }
  return {};
}

/**
 * Build the `ToolContext` the pipeline expects from the PRAO
 * `ExecutionContext`. `ExecutionContext` doesn't expose a working directory,
 * so we default to `process.cwd()` (the agent process's cwd is the correct
 * default for tool execution). The abort signal is forwarded so the
 * pipeline can race tool execution against the agent's abort signal.
 *
 * A logger is intentionally NOT injected here by default: the pipeline happily
 * accepts an undefined logger, and adding `console.*` calls in source would
 * violate the "no console.log in source" constraint. Tools that need to log
 * can pull a logger out of `ctx.metadata.logger` themselves (callers may set
 * one via `ctx.set("logger", ...)`).
 */
function buildToolContext(ctx: ExecutionContext): ToolContext {
  const toolCtx: ToolContext = {
    workingDirectory: process.cwd(),
    abortSignal: ctx.signal,
  };
  // Forward a logger if the caller stashed one on metadata (opt-in).
  const metaLogger = ctx.get<ToolContext["logger"]>("logger");
  if (metaLogger && typeof metaLogger === "object") {
    toolCtx.logger = metaLogger;
  }
  return toolCtx;
}

/**
 * Create an `ActHandler` that delegates tool calls to the `ToolPipeline`.
 *
 * Behavior:
 *   1. If `decision` has no `toolCalls` (or it's null / undefined / empty),
 *      returns `{ decision, toolActResult: { toolCallsMade: false, toolResults: [] } }`.
 *   2. Otherwise, calls `pipeline.executeBatch(toolCalls, ctx)` to run all
 *      tools concurrently. The pipeline always resolves — tool errors come
 *      back as structured `ToolResultEntry` objects, never thrown.
 *   3. Wraps the results in a `ToolActResult` and returns it for the Observe
 *      phase to feed back to the LLM.
 *
 * The handler NEVER throws for tool-related failures — those are surfaced as
 * `ToolResultEntry` entries with `success: false`. The only way `act()`
 * rejects is if `pipeline.executeBatch` itself throws synchronously (caller
 * bug, e.g. passing a malformed pipeline) — that's a programming error, not
 * a tool error, and propagating it is correct.
 */
export function createToolActHandler(pipeline: ToolPipeline): ActHandler {
  return {
    act: async (decision: unknown, ctx: ExecutionContext): Promise<unknown> => {
      const toolCalls = extractToolCalls(decision);
      const decisionShape = asToolDecision(decision);

      // No tool calls — return immediately with an empty result envelope.
      if (toolCalls === null) {
        return {
          decision: decisionShape,
          toolActResult: {
            toolCallsMade: false,
            toolResults: [],
          },
        } satisfies ToolActionResult;
      }

      // Execute all tool calls concurrently via the pipeline.
      const toolCtx = buildToolContext(ctx);
      const toolResults: ToolResultEntry[] = await pipeline.executeBatch(
        toolCalls,
        toolCtx,
      );

      return {
        decision: decisionShape,
        toolActResult: {
          toolCallsMade: true,
          toolResults,
        },
      } satisfies ToolActionResult;
    },
  };
}
