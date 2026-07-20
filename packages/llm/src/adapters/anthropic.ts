import type { Message } from "@frogcode/core";
import {
  AbortedError,
  InvalidResponseError,
  NetworkError,
  RateLimitError,
  UnsupportedError,
} from "../errors/index.js";
import type { LLMProvider } from "../provider/interface.js";
import type { TokenBudget } from "../provider/token-budget.js";
import { RetryExecutor } from "../retry/executor.js";
import { SSEParser } from "../streaming/sse-parser.js";
import type {
  CallOptions,
  ChatChunk,
  ChatRequest,
  ChatResponse,
  EmbedResponse,
  FinishReason,
  TokenUsage,
  ToolCall,
} from "../types/index.js";

const ANTHROPIC_API_VERSION = "2023-06-01";
const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  tokenBudget?: TokenBudget;
}

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

interface AnthropicResponse {
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  // Anthropic 官方 API 必返 usage，但兼容生态有时返回 null 或省略。
  // 视为可选并在缺失时返回零值——与 OpenAIProvider 保持一致。
  usage?: AnthropicUsage | null;
  model: string;
}

interface AnthropicStreamPayload {
  type: string;
  index?: number;
  content_block?: {
    type: string;
    id?: string;
    name?: string;
    text?: string;
  };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: { input_tokens?: number; output_tokens?: number };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
}

/**
 * Bridge a `ReadableStream<Uint8Array>` (fetch `Response.body`) to the
 * `AsyncIterable<Uint8Array>` that {@link SSEParser.parse} consumes.
 *
 * `ReadableStream` is async-iterable at runtime in Node 18+, but its TS lib
 * declaration does not declare `AsyncIterable`, so we drive it via an
 * explicit reader loop.
 */
async function* streamToAsyncIterable(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value !== undefined) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export class AnthropicProvider implements LLMProvider {
  readonly apiKey: string;
  readonly model: string;
  readonly baseURL: string;
  readonly tokenBudget?: TokenBudget;

  constructor(opts: AnthropicProviderOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseURL = opts.baseURL ?? DEFAULT_BASE_URL;
    this.tokenBudget = opts.tokenBudget;
  }

  async chat(req: ChatRequest, opts?: CallOptions): Promise<ChatResponse> {
    const body = this.#buildRequestBody(req, false);
    return RetryExecutor.execute(
      async () => {
        try {
          const res = await fetch(`${this.baseURL}/messages`, {
            method: "POST",
            headers: this.#headers(),
            body: JSON.stringify(body),
            signal: opts?.signal,
          });
          if (!res.ok) throw await this.#mapHttpError(res);
          let json: AnthropicResponse;
          try {
            json = (await res.json()) as AnthropicResponse;
          } catch {
            throw new InvalidResponseError(
              "Anthropic response body is not valid JSON",
            );
          }
          const response = this.#mapResponse(json);
          this.#trackBudget(response.usage);
          return response;
        } catch (e) {
          if (opts?.signal?.aborted) {
            throw new AbortedError("Anthropic chat request aborted");
          }
          throw e;
        }
      },
      undefined,
      opts?.signal,
    );
  }

  async *stream(
    req: ChatRequest,
    opts?: CallOptions,
  ): AsyncIterable<ChatChunk> {
    const body = this.#buildRequestBody(req, true);
    const res = await RetryExecutor.execute(
      async () => {
        try {
          const r = await fetch(`${this.baseURL}/messages`, {
            method: "POST",
            headers: this.#headers(),
            body: JSON.stringify(body),
            signal: opts?.signal,
          });
          if (!r.ok) throw await this.#mapHttpError(r);
          return r;
        } catch (e) {
          if (opts?.signal?.aborted) {
            throw new AbortedError("Anthropic stream request aborted");
          }
          throw e;
        }
      },
      undefined,
      opts?.signal,
    );

    if (res.body === null) {
      throw new InvalidResponseError("Anthropic stream response has no body");
    }

    const parser = new SSEParser();
    let inputTokens = 0;
    let lastStopReason: FinishReason = "stop";
    const argBuffers = new Map<number, string>();
    let finalUsage: TokenUsage | null = null;

    for await (const evt of parser.parse(streamToAsyncIterable(res.body))) {
      if (evt.data === "[DONE]") break;

      let payload: AnthropicStreamPayload;
      try {
        payload = JSON.parse(evt.data) as AnthropicStreamPayload;
      } catch {
        continue;
      }

      const type = evt.event ?? payload.type;

      if (type === "message_start") {
        const usage = payload.message?.usage;
        if (usage?.input_tokens !== undefined) {
          inputTokens = usage.input_tokens;
        }
        continue;
      }

      if (type === "content_block_start") {
        const block = payload.content_block;
        if (block?.type === "tool_use") {
          const index = payload.index ?? 0;
          argBuffers.set(index, "");
          yield {
            delta: {
              toolCall: {
                id: block.id,
                name: block.name,
              },
            },
          };
        }
        continue;
      }

      if (type === "content_block_delta") {
        const delta = payload.delta;
        if (delta?.type === "text_delta") {
          yield { delta: { content: delta.text } };
          continue;
        }
        if (delta?.type === "input_json_delta") {
          const index = payload.index ?? 0;
          const prev = argBuffers.get(index) ?? "";
          const next = prev + (delta.partial_json ?? "");
          argBuffers.set(index, next);
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(next) as Record<string, unknown>;
          } catch {
            continue;
          }
          yield { delta: { toolCall: { arguments: args } } };
          continue;
        }
        continue;
      }

      if (type === "content_block_stop") {
        continue;
      }

      if (type === "message_delta") {
        if (payload.delta?.stop_reason !== undefined) {
          lastStopReason = this.#mapStopReason(payload.delta.stop_reason);
        }
        const usage = payload.usage;
        if (usage?.output_tokens !== undefined) {
          const outputTokens = usage.output_tokens;
          const tokenUsage: TokenUsage = {
            promptTokens: inputTokens,
            completionTokens: outputTokens,
            totalTokens: inputTokens + outputTokens,
          };
          finalUsage = tokenUsage;
          yield { delta: {}, usage: tokenUsage };
        }
        continue;
      }

      if (type === "message_stop") {
        yield { delta: {}, finishReason: lastStopReason };
      }
    }

    if (finalUsage !== null) {
      this.#trackBudget(finalUsage);
    }
  }

  embed(_text: string, _opts?: CallOptions): Promise<EmbedResponse> {
    throw new UnsupportedError("Anthropic does not support embeddings");
  }

  #headers(): Record<string, string> {
    return {
      "x-api-key": this.apiKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
      "Content-Type": "application/json",
    };
  }

  #buildRequestBody(
    req: ChatRequest,
    stream: boolean,
  ): Record<string, unknown> {
    const systemMessage = req.messages.find((m) => m.role === "system");
    const messages = req.messages
      .filter((m) => m.role !== "system")
      .map((m: Message) => ({ role: m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
    if (systemMessage !== undefined) {
      body.system = systemMessage.content;
    }
    if (req.temperature !== undefined) {
      body.temperature = req.temperature;
    }
    if (stream) {
      body.stream = true;
    }
    return body;
  }

  #mapResponse(json: AnthropicResponse): ChatResponse {
    let content = "";
    const toolCalls: ToolCall[] = [];
    for (const block of json.content) {
      if (block.type === "text") {
        content += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input,
        });
      }
    }

    const inputTokens = json.usage?.input_tokens ?? 0;
    const outputTokens = json.usage?.output_tokens ?? 0;

    return {
      content,
      usage: {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
      finishReason: this.#mapStopReason(json.stop_reason),
      model: json.model,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  #mapStopReason(reason: string | null | undefined): FinishReason {
    switch (reason) {
      case "end_turn":
        return "stop";
      case "tool_use":
        return "tool_calls";
      case "max_tokens":
        return "length";
      default:
        return "stop";
    }
  }

  async #mapHttpError(res: Response): Promise<Error> {
    if (res.status === 429) {
      const retryAfterHeader = res.headers.get("Retry-After");
      const retryAfterSec = Number(retryAfterHeader);
      return new RateLimitError("Anthropic API rate limited (429)", {
        retryAfter:
          Number.isFinite(retryAfterSec) && retryAfterSec > 0
            ? retryAfterSec
            : undefined,
      });
    }
    if (res.status >= 500) {
      return new NetworkError(`Anthropic API server error (${res.status})`);
    }
    let raw: unknown;
    try {
      raw = await res.text();
    } catch {
      raw = undefined;
    }
    return new InvalidResponseError(`Anthropic API error (${res.status})`, {
      raw,
    });
  }

  #trackBudget(usage: TokenUsage): void {
    if (this.tokenBudget === undefined) return;
    this.tokenBudget.track(usage);
    this.tokenBudget.check();
  }
}
