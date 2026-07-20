import type { Message } from "@frogcode/core";
import {
  AbortedError,
  InvalidResponseError,
  NetworkError,
  RateLimitError,
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
  ToolDefinition,
} from "../types/index.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface OpenAIProviderOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  tokenBudget?: TokenBudget;
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIMessage {
  role: string;
  content: string | null;
  tool_calls?: OpenAIToolCall[];
}

interface OpenAIChoice {
  message: OpenAIMessage;
  finish_reason: string | null;
}

interface OpenAIChatResponse {
  id: string;
  choices: OpenAIChoice[];
  // OpenAI 官方 API 必返 usage，但 OpenAI-compatible 生态（本地 gateway、
  // vLLM、ollama 等）有时返回 null 或省略该字段。视为可选并在缺失时返回零值，
  // 这是兼容生态的现实——不是所有实现都完整。
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null;
  model: string;
}

interface OpenAIStreamDelta {
  content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }>;
}

interface OpenAIStreamChoice {
  delta: OpenAIStreamDelta;
  finish_reason?: string | null;
}

interface OpenAIStreamChunk {
  choices: OpenAIStreamChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null;
}

interface OpenAIEmbedResponse {
  data: Array<{ embedding: number[] }>;
  usage: { prompt_tokens: number; total_tokens: number };
  model: string;
}

interface OpenAIToolRequest {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
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

/**
 * OpenAI Chat Completions adapter.
 *
 * Uses native `fetch` (NOT the `openai` SDK). All retry semantics are
 * delegated to {@link RetryExecutor}; SSE parsing to {@link SSEParser};
 * token accounting to {@link TokenBudget} (when provided).
 *
 * The `model` is bound at construction time per the plan
 * ("model在provider创建时绑定") and is used for every request regardless
 * of the `req.model` field on individual {@link ChatRequest}s.
 */
export class OpenAIProvider implements LLMProvider {
  readonly apiKey: string;
  readonly model: string;
  readonly baseURL: string;
  readonly tokenBudget?: TokenBudget;

  constructor(opts: OpenAIProviderOptions) {
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
          const res = await fetch(`${this.baseURL}/chat/completions`, {
            method: "POST",
            headers: this.#headers(),
            body: JSON.stringify(body),
            signal: opts?.signal,
          });
          if (!res.ok) throw await this.#mapHttpError(res);
          let json: OpenAIChatResponse;
          try {
            json = (await res.json()) as OpenAIChatResponse;
          } catch {
            throw new InvalidResponseError(
              "OpenAI response body is not valid JSON",
            );
          }
          const response = this.#mapResponse(json);
          this.#trackBudget(response.usage);
          return response;
        } catch (e) {
          if (opts?.signal?.aborted) {
            throw new AbortedError("OpenAI chat request aborted");
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
          const r = await fetch(`${this.baseURL}/chat/completions`, {
            method: "POST",
            headers: this.#headers(),
            body: JSON.stringify(body),
            signal: opts?.signal,
          });
          if (!r.ok) throw await this.#mapHttpError(r);
          return r;
        } catch (e) {
          if (opts?.signal?.aborted) {
            throw new AbortedError("OpenAI stream request aborted");
          }
          throw e;
        }
      },
      undefined,
      opts?.signal,
    );

    if (res.body === null) {
      throw new InvalidResponseError("OpenAI stream response has no body");
    }

    const parser = new SSEParser();
    // Per-index argument fragment buffer. OpenAI streams tool call
    // `function.arguments` as JSON string deltas; we concatenate and
    // JSON.parse on each delta, yielding the parsed partial only when it
    // forms a complete JSON value (matches Anthropic adapter pattern).
    const argBuffers = new Map<number, string>();
    let finalUsage: TokenUsage | null = null;

    for await (const evt of parser.parse(streamToAsyncIterable(res.body))) {
      if (evt.data === "[DONE]") break;

      let payload: OpenAIStreamChunk;
      try {
        payload = JSON.parse(evt.data) as OpenAIStreamChunk;
      } catch {
        continue;
      }

      const choice = payload.choices?.[0];
      if (choice === undefined) {
        // Some chunks (e.g. final usage-only chunk) may carry no choices.
        if (payload.usage !== undefined && payload.usage !== null) {
          const usage = this.#mapUsage(payload.usage);
          finalUsage = usage;
          yield { delta: {}, usage };
        }
        continue;
      }

      const delta = choice.delta;

      if (delta.content !== undefined && delta.content !== null) {
        yield { delta: { content: delta.content } };
      }

      if (delta.tool_calls !== undefined) {
        for (const tc of delta.tool_calls) {
          const index = tc.index;
          // First chunk for a tool call carries id + name.
          if (tc.id !== undefined || tc.function?.name !== undefined) {
            const partial: Partial<ToolCall> = {};
            if (tc.id !== undefined) partial.id = tc.id;
            if (tc.function?.name !== undefined) {
              partial.name = tc.function.name;
            }
            yield { delta: { toolCall: partial } };
          }
          // Argument fragment(s): accumulate, attempt JSON.parse, yield
          // the parsed object only once it forms a complete JSON value.
          if (tc.function?.arguments !== undefined) {
            const prev = argBuffers.get(index) ?? "";
            const next = prev + tc.function.arguments;
            argBuffers.set(index, next);
            let args: Record<string, unknown>;
            try {
              args = JSON.parse(next) as Record<string, unknown>;
            } catch {
              continue;
            }
            yield { delta: { toolCall: { arguments: args } } };
          }
        }
      }

      if (choice.finish_reason) {
        yield {
          delta: {},
          finishReason: this.#mapFinishReason(choice.finish_reason),
        };
      }

      if (payload.usage !== undefined && payload.usage !== null) {
        const usage = this.#mapUsage(payload.usage);
        finalUsage = usage;
        yield { delta: {}, usage };
      }
    }

    if (finalUsage !== null) {
      this.#trackBudget(finalUsage);
    }
  }

  async embed(text: string, opts?: CallOptions): Promise<EmbedResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      input: text,
    };
    return RetryExecutor.execute(
      async () => {
        try {
          const res = await fetch(`${this.baseURL}/embeddings`, {
            method: "POST",
            headers: this.#headers(),
            body: JSON.stringify(body),
            signal: opts?.signal,
          });
          if (!res.ok) throw await this.#mapHttpError(res);
          let json: OpenAIEmbedResponse;
          try {
            json = (await res.json()) as OpenAIEmbedResponse;
          } catch {
            throw new InvalidResponseError(
              "OpenAI embeddings response body is not valid JSON",
            );
          }
          const embedding = json.data[0]?.embedding;
          if (embedding === undefined) {
            throw new InvalidResponseError(
              "OpenAI embeddings response has no data[0].embedding",
              { raw: json },
            );
          }
          const usage = this.#mapUsage({
            prompt_tokens: json.usage.prompt_tokens,
            completion_tokens: 0,
            total_tokens: json.usage.total_tokens,
          });
          this.#trackBudget(usage);
          return {
            embedding,
            usage,
            model: json.model,
          };
        } catch (e) {
          if (opts?.signal?.aborted) {
            throw new AbortedError("OpenAI embed request aborted");
          }
          throw e;
        }
      },
      undefined,
      opts?.signal,
    );
  }

  #headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  #buildRequestBody(
    req: ChatRequest,
    stream: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: req.messages.map((m: Message) => ({
        role: m.role,
        content: m.content,
      })),
    };
    if (req.temperature !== undefined) {
      body.temperature = req.temperature;
    }
    if (req.maxTokens !== undefined) {
      body.max_tokens = req.maxTokens;
    }
    if (req.tools !== undefined && req.tools.length > 0) {
      body.tools = req.tools.map(
        (t: ToolDefinition): OpenAIToolRequest => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        }),
      );
    }
    if (stream) {
      body.stream = true;
    }
    return body;
  }

  #mapResponse(json: OpenAIChatResponse): ChatResponse {
    const choice = json.choices[0];
    if (choice === undefined) {
      throw new InvalidResponseError("OpenAI response has no choices[0]", {
        raw: json,
      });
    }

    const content = choice.message.content ?? "";
    let toolCalls: ToolCall[] | undefined;
    if (
      choice.message.tool_calls !== undefined &&
      choice.message.tool_calls.length > 0
    ) {
      toolCalls = choice.message.tool_calls.map((tc): ToolCall => {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch (e) {
          throw new InvalidResponseError(
            `OpenAI tool call arguments are not valid JSON: ${tc.function.arguments}`,
            { raw: tc },
          );
        }
        return {
          id: tc.id,
          name: tc.function.name,
          arguments: args,
        };
      });
    }

    const usage = this.#mapUsage(json.usage);

    return {
      content,
      usage,
      finishReason: this.#mapFinishReason(choice.finish_reason),
      model: json.model,
      toolCalls,
    };
  }

  #mapUsage(
    u:
      | {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
        }
      | null
      | undefined,
  ): TokenUsage {
    // OpenAI 官方 API 必返 usage，但兼容生态（本地 gateway、vLLM、ollama 等）
    // 可能返回 null 或省略该字段。缺失时返回零值——这是兼容生态的现实，
    // 不视为错误。token-budget 跟踪零值无副作用。
    if (u === null || u === undefined) {
      return {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      };
    }
    return {
      promptTokens: u.prompt_tokens,
      completionTokens: u.completion_tokens,
      totalTokens: u.total_tokens,
    };
  }

  #mapFinishReason(reason: string | null | undefined): FinishReason {
    switch (reason) {
      case "stop":
        return "stop";
      case "tool_calls":
        return "tool_calls";
      case "length":
        return "length";
      case "content_filter":
        return "content_filter";
      default:
        return "stop";
    }
  }

  async #mapHttpError(res: Response): Promise<Error> {
    if (res.status === 429) {
      const retryAfterHeader = res.headers.get("Retry-After");
      const retryAfterSec = Number(retryAfterHeader);
      return new RateLimitError("OpenAI API rate limited (429)", {
        retryAfter:
          Number.isFinite(retryAfterSec) && retryAfterSec > 0
            ? retryAfterSec
            : undefined,
      });
    }
    if (res.status >= 500) {
      return new NetworkError(`OpenAI API server error (${res.status})`);
    }
    let raw: unknown;
    try {
      raw = await res.text();
    } catch {
      raw = undefined;
    }
    return new InvalidResponseError(`OpenAI API error (${res.status})`, {
      raw,
    });
  }

  #trackBudget(usage: TokenUsage): void {
    if (this.tokenBudget === undefined) return;
    this.tokenBudget.track(usage);
    this.tokenBudget.check();
  }
}
