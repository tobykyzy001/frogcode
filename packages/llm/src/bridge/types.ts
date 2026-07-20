import type { PromptTemplate } from "../prompt/template.js";
import type { SchemaValidator } from "../schema/types.js";
import type { ToolDefinition } from "../types/index.js";

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
 */
export interface LLMHandlersOptions {
  model: string;
  promptRegistry?: Map<string, PromptTemplate>;
  schemaValidator?: SchemaValidator;
  maxValidationAttempts?: number;
  tools?: ToolDefinition[];
}

/**
 * Default number of validation attempts (initial + retries) used when
 * `schemaValidator` is supplied but `maxValidationAttempts` is omitted.
 */
export const DEFAULT_MAX_VALIDATION_ATTEMPTS = 3;
