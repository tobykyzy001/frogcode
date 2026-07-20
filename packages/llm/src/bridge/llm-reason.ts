import type {
  ExecutionContext,
  ReasonHandler,
  ReasonResult,
} from "@frogcode/core";
import { InvalidResponseError } from "../errors/index.js";
import type { PromptTemplate } from "../prompt/template.js";
import type { LLMProvider } from "../provider/interface.js";
import type { SchemaValidator, ValidationError } from "../schema/types.js";
import {
  ValidationChain,
  ValidationExhaustedError,
} from "../schema/validation-chain.js";
import type {
  ChatRequest,
  ChatResponse,
  ToolCall,
  ToolDefinition,
} from "../types/index.js";
import {
  DEFAULT_MAX_VALIDATION_ATTEMPTS,
  type LLMHandlersOptions,
} from "./types.js";

/**
 * Reason handler that asks the LLM what to do next.
 *
 * Flow:
 *  1. Build a {@link ChatRequest} with the perception as the user message
 *     (rendered through the `"reason"` prompt template when one is
 *     registered) and forward any configured `tools`.
 *  2. Call `provider.chat`.
 *  3. If the response carries tool calls:
 *     - When a {@link SchemaValidator} is configured, validate the first
 *       tool call's arguments, re-prompting the LLM with the validation
 *       errors on failure (up to `maxValidationAttempts`). Exhaustion
 *       throws {@link ValidationExhaustedError}.
 *     - Without a validator, the tool call is returned as-is.
 *     The action becomes the (validated) tool call and `done` is `false`.
 *  4. Otherwise the action is `response.content` and `done` is `true` when
 *     the LLM signalled a natural stop.
 */
export class LLMReasonHandler implements ReasonHandler {
  private readonly provider: LLMProvider;
  private readonly model: string;
  private readonly reasonTemplate?: PromptTemplate;
  private readonly schemaValidator?: SchemaValidator;
  private readonly maxValidationAttempts: number;
  private readonly tools?: ToolDefinition[];

  constructor(provider: LLMProvider, opts: LLMHandlersOptions) {
    this.provider = provider;
    this.model = opts.model;
    this.reasonTemplate = opts.promptRegistry?.get("reason");
    this.schemaValidator = opts.schemaValidator;
    this.maxValidationAttempts =
      opts.maxValidationAttempts ?? DEFAULT_MAX_VALIDATION_ATTEMPTS;
    this.tools = opts.tools;
  }

  async reason(
    perception: unknown,
    ctx: ExecutionContext,
  ): Promise<ReasonResult> {
    const req = this.buildInitialRequest(perception, ctx);
    const res = await this.provider.chat(req, { signal: ctx.signal });

    const toolCalls = res.toolCalls;
    if (toolCalls && toolCalls.length > 0) {
      const action = await this.resolveToolAction(
        toolCalls[0],
        perception,
        ctx,
      );
      return { action, done: false };
    }

    return {
      action: res.content,
      done: res.finishReason === "stop",
    };
  }

  private buildInitialRequest(
    perception: unknown,
    ctx: ExecutionContext,
  ): ChatRequest {
    const content = this.renderContent(perception);
    return {
      messages: [
        {
          id: `reason-${ctx.agentId}-${Date.now()}`,
          role: "user",
          content,
          timestamp: Date.now(),
        },
      ],
      model: this.model,
      ...(this.tools ? { tools: this.tools } : {}),
    };
  }

  private renderContent(perception: unknown): string {
    if (this.reasonTemplate) {
      return this.reasonTemplate.render({ perception });
    }
    return stringifyPerception(perception);
  }

  private async resolveToolAction(
    toolCall: ToolCall,
    perception: unknown,
    ctx: ExecutionContext,
  ): Promise<ToolCall> {
    if (!this.schemaValidator) {
      return toolCall;
    }

    const chain = new ValidationChain({
      validator: this.schemaValidator,
      maxAttempts: this.maxValidationAttempts,
    });

    const validatedArgs = await chain.validateWithRetry(
      toolCall.arguments,
      async (errors: ValidationError[]) => {
        const retryRes = await this.provider.chat(
          this.buildRetryRequest(perception, errors, ctx),
          { signal: ctx.signal },
        );
        const retried = retryRes.toolCalls?.[0];
        if (!retried) {
          throw new InvalidResponseError(
            "LLM did not return a tool call during validation retry",
            { raw: retryRes },
          );
        }
        return retried.arguments;
      },
    );

    return { ...toolCall, arguments: validatedArgs as Record<string, unknown> };
  }

  private buildRetryRequest(
    perception: unknown,
    errors: ValidationError[],
    ctx: ExecutionContext,
  ): ChatRequest {
    const errorLines = errors
      .map(
        (e) =>
          `- path '${e.path}': ${e.message} (expected ${e.expected}, received ${e.received})`,
      )
      .join("\n");
    const content = [
      "Previous tool call arguments failed schema validation:",
      errorLines,
      "Please return corrected tool call arguments.",
    ].join("\n");

    return {
      messages: [
        {
          id: `reason-retry-${ctx.agentId}-${Date.now()}`,
          role: "user",
          content,
          timestamp: Date.now(),
        },
      ],
      model: this.model,
      ...(this.tools ? { tools: this.tools } : {}),
    };
  }
}

function stringifyPerception(perception: unknown): string {
  if (typeof perception === "string") {
    return perception;
  }
  return String(perception);
}

// Re-export so consumers can catch the exhaustion error without reaching into
// the schema layer directly.
export { ValidationExhaustedError };
