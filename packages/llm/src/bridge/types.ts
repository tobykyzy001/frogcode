import type { PromptTemplate } from "../prompt/template.js";
import type { SchemaValidator } from "../schema/types.js";
import type { ToolCall, ToolDefinition } from "../types/index.js";

/**
 * Options for {@link createLLMHandlers}.
 *
 * `model` is required because every {@link ChatRequest} sent to the provider
 * must name a model — the bridge does not pick a default (per AGENTS.md:
 * no fallback strategies).
 *
 * `promptRegistry` optionally supplies named {@link PromptTemplate} instances
 * used to wrap the raw perception / reason inputs before they are sent to the
 * LLM. Recognised keys: `"perceive"`, `"reason"`.
 *
 * `schemaValidator`, when provided, enables validation of tool-call arguments
 * returned by the LLM. Validation failures are retried (re-prompting the LLM
 * with the errors) up to `maxValidationAttempts` times.
 *
 * `tools` is forwarded to the LLM on every `reason` call so the model can
 * decide whether to emit tool calls.
 *
 * `toolRegistry`, when set, is the preferred way to supply tools: the reason
 * handler calls `toolRegistry.toLLMTools()` on every `reason` invocation and
 * passes the resulting array as the `tools` field of the {@link ChatRequest}.
 * Typed structurally (no `@frogcode/tools` import) so the LLM bridge stays a
 * pure protocol layer. When both `toolRegistry` and `tools` are set,
 * `toolRegistry` takes precedence.
 *
 * `onToolCall` is an optional hook invoked once per tool call emitted by the
 * LLM. Used by the CLI for real-time visualization (e.g. printing
 * "[tool: fs.read] calling..."). It is a pure observer — it cannot mutate the
 * tool call.
 */
export interface LLMHandlersOptions {
  model: string;
  promptRegistry?: Map<string, PromptTemplate>;
  schemaValidator?: SchemaValidator;
  maxValidationAttempts?: number;
  tools?: ToolDefinition[];
  toolRegistry?: {
    toLLMTools: () => ToolDefinition[];
  };
  onToolCall?: (call: ToolCall) => void;
}

/**
 * Default number of validation attempts (initial + retries) used when
 * `schemaValidator` is supplied but `maxValidationAttempts` is omitted.
 */
export const DEFAULT_MAX_VALIDATION_ATTEMPTS = 3;
