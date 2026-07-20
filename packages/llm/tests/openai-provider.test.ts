import type { Message } from "@frogcode/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAIProvider } from "../src/adapters/openai.js";
import {
  AbortedError,
  InvalidResponseError,
  LLMRetryExhaustedError,
  NetworkError,
  RateLimitError,
} from "../src/errors/index.js";
import type { ChatChunk, ChatRequest } from "../src/types/index.js";

// ---------- helpers ----------

let messageCounter = 0;
function msg(role: Message["role"], content: string): Message {
  messageCounter += 1;
  return {
    id: `m-${messageCounter}`,
    role,
    content,
    timestamp: Date.now(),
  };
}

function chatRequest(
  messages: Message[],
  overrides: Partial<ChatRequest> = {},
): ChatRequest {
  return { model: "gpt-4o", messages, ...overrides };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function streamingResponse(sseText: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sseText));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

// Build SSE `data:` lines via JSON.stringify to avoid manual JSON-escape
// mistakes (the OpenAI `arguments` field is itself a JSON string, so its
// inner quotes must be escaped at the JSON layer).
function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}`;
}

// A minimal OpenAI chat completion SSE stream:
//   - 2 text deltas
//   - 1 tool call (id+name first, then 2 argument fragments that together
//     form a complete JSON object)
//   - usage on the final chunk (stream_options.include_usage style)
//   - finish_reason on the final chunk
const OPENAI_SSE = [
  sseData({
    id: "chatcmpl-1",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "Hello" },
        finish_reason: null,
      },
    ],
  }),
  "",
  sseData({
    id: "chatcmpl-1",
    choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }],
  }),
  "",
  sseData({
    id: "chatcmpl-1",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_abc",
              type: "function",
              function: { name: "get_weather", arguments: "" },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  }),
  "",
  sseData({
    id: "chatcmpl-1",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [{ index: 0, function: { arguments: '{"location":' } }],
        },
        finish_reason: null,
      },
    ],
  }),
  "",
  sseData({
    id: "chatcmpl-1",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [{ index: 0, function: { arguments: '"SF"}' } }],
        },
        finish_reason: null,
      },
    ],
  }),
  "",
  sseData({
    id: "chatcmpl-1",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  }),
  "",
  "data: [DONE]",
  "",
  "",
].join("\n");

// ---------- tests ----------

describe("OpenAIProvider", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function provider(opts?: {
    baseURL?: string;
    // biome-ignore lint/suspicious/noExplicitAny: test-only fake budget
    tokenBudget?: any;
    model?: string;
  }): OpenAIProvider {
    return new OpenAIProvider({
      apiKey: "test-key",
      model: opts?.model ?? "gpt-4o",
      baseURL: opts?.baseURL,
      tokenBudget: opts?.tokenBudget,
    });
  }

  describe("constructor", () => {
    it("defaults baseURL to https://api.openai.com/v1", () => {
      const p = provider();
      expect(p.baseURL).toBe("https://api.openai.com/v1");
    });

    it("uses provided baseURL when given", () => {
      const p = provider({ baseURL: "https://custom.example.com/v1" });
      expect(p.baseURL).toBe("https://custom.example.com/v1");
    });

    it("exposes apiKey and model", () => {
      const p = provider({ model: "gpt-4o-mini" });
      expect(p.apiKey).toBe("test-key");
      expect(p.model).toBe("gpt-4o-mini");
    });

    it("binds model at construction (ignores req.model)", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          id: "x",
          choices: [
            {
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          model: "gpt-4o",
        }),
      );

      // req.model is "claude-..." but provider's bound model is "gpt-4o".
      await provider({ model: "gpt-4o" }).chat(
        chatRequest([msg("user", "hi")], { model: "claude-irrelevant" }),
      );

      const body = JSON.parse(
        (fetchMock.mock.calls[0][1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      expect(body.model).toBe("gpt-4o");
    });
  });

  describe("chat()", () => {
    it("sends correct request: URL, method, headers, body", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          id: "chatcmpl-1",
          choices: [
            {
              message: { role: "assistant", content: "Hi there" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          model: "gpt-4o",
        }),
      );

      await provider().chat(chatRequest([msg("user", "Hi")]));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.openai.com/v1/chat/completions");
      expect(init.method).toBe("POST");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-key");
      expect(headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.model).toBe("gpt-4o");
      expect(body.messages).toEqual([{ role: "user", content: "Hi" }]);
    });

    it("passes temperature when provided", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          id: "x",
          choices: [
            {
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          model: "gpt-4o",
        }),
      );

      await provider().chat({
        model: "gpt-4o",
        messages: [msg("user", "hi")],
        temperature: 0.7,
      });

      const body = JSON.parse(
        (fetchMock.mock.calls[0][1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      expect(body.temperature).toBe(0.7);
    });

    it("passes max_tokens when provided", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          id: "x",
          choices: [
            {
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          model: "gpt-4o",
        }),
      );

      await provider().chat({
        model: "gpt-4o",
        messages: [msg("user", "hi")],
        maxTokens: 100,
      });

      const body = JSON.parse(
        (fetchMock.mock.calls[0][1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      expect(body.max_tokens).toBe(100);
    });

    it("omits temperature and max_tokens when not provided", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          id: "x",
          choices: [
            {
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          model: "gpt-4o",
        }),
      );

      await provider().chat(chatRequest([msg("user", "hi")]));

      const body = JSON.parse(
        (fetchMock.mock.calls[0][1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      expect(body.temperature).toBeUndefined();
      expect(body.max_tokens).toBeUndefined();
    });

    it("maps tools to OpenAI function tool format", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          id: "x",
          choices: [
            {
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          model: "gpt-4o",
        }),
      );

      await provider().chat({
        model: "gpt-4o",
        messages: [msg("user", "weather?")],
        tools: [
          {
            name: "get_weather",
            description: "Get weather",
            parameters: {
              type: "object",
              properties: { location: { type: "string" } },
            },
          },
        ],
      });

      const body = JSON.parse(
        (fetchMock.mock.calls[0][1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      expect(body.tools).toEqual([
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather",
            parameters: {
              type: "object",
              properties: { location: { type: "string" } },
            },
          },
        },
      ]);
    });

    it("omits tools field when request has no tools", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          id: "x",
          choices: [
            {
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          model: "gpt-4o",
        }),
      );

      await provider().chat(chatRequest([msg("user", "hi")]));

      const body = JSON.parse(
        (fetchMock.mock.calls[0][1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      expect(body.tools).toBeUndefined();
    });

    it("maps response content and usage", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          id: "chatcmpl-1",
          choices: [
            {
              message: { role: "assistant", content: "Hello!" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          model: "gpt-4o",
        }),
      );

      const res = await provider().chat(chatRequest([msg("user", "hi")]));

      expect(res.content).toBe("Hello!");
      expect(res.usage).toEqual({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      });
      expect(res.model).toBe("gpt-4o");
      expect(res.finishReason).toBe("stop");
      expect(res.toolCalls).toBeUndefined();
    });

    it("maps tool_calls to ToolCall[] with parsed arguments", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          id: "chatcmpl-1",
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_abc",
                    type: "function",
                    function: {
                      name: "get_weather",
                      arguments: '{"location":"SF"}',
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
          model: "gpt-4o",
        }),
      );

      const res = await provider().chat(chatRequest([msg("user", "weather?")]));

      expect(res.toolCalls).toBeDefined();
      expect(res.toolCalls).toHaveLength(1);
      expect(res.toolCalls?.[0]).toEqual({
        id: "call_abc",
        name: "get_weather",
        arguments: { location: "SF" },
      });
      expect(res.finishReason).toBe("tool_calls");
    });

    it("maps finish_reason length -> length", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          id: "x",
          choices: [
            {
              message: { role: "assistant", content: "..." },
              finish_reason: "length",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          model: "gpt-4o",
        }),
      );

      const res = await provider().chat(chatRequest([msg("user", "x")]));
      expect(res.finishReason).toBe("length");
    });

    it("maps finish_reason content_filter -> content_filter", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          id: "x",
          choices: [
            {
              message: { role: "assistant", content: "" },
              finish_reason: "content_filter",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          model: "gpt-4o",
        }),
      );

      const res = await provider().chat(chatRequest([msg("user", "x")]));
      expect(res.finishReason).toBe("content_filter");
    });

    it("maps HTTP 429 to RateLimitError (retried, ultimately LLMRetryExhaustedError)", async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValue(
        new Response("{}", { status: 429, headers: { "Retry-After": "0" } }),
      );

      const p = provider().chat(chatRequest([msg("user", "x")]));
      // Attach error handler BEFORE advancing timers so the rejection that
      // fires during timer advancement is never unhandled.
      const settled = p.then(
        (v) => v,
        (e) => e,
      );
      await vi.advanceTimersByTimeAsync(60000);
      const err = await settled;

      expect(err).toBeInstanceOf(LLMRetryExhaustedError);
      const exhausted = err as LLMRetryExhaustedError;
      expect(exhausted.lastError).toBeInstanceOf(RateLimitError);
      const rateLimit = exhausted.lastError as RateLimitError;
      expect(rateLimit.retryAfter).toBe(0);
      expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    });

    it("extracts Retry-After header (seconds) into retryAfter", async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValue(
        new Response("{}", { status: 429, headers: { "Retry-After": "5" } }),
      );

      const p = provider().chat(chatRequest([msg("user", "x")]));
      const settled = p.then(
        (v) => v,
        (e) => e,
      );
      await vi.advanceTimersByTimeAsync(60000);
      const err = (await settled) as LLMRetryExhaustedError;
      const rateLimit = err.lastError as RateLimitError;
      expect(rateLimit.retryAfter).toBe(5);
    });

    it("maps HTTP 500 to NetworkError (retried, ultimately LLMRetryExhaustedError)", async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValue(
        new Response("server error", { status: 500 }),
      );

      const p = provider().chat(chatRequest([msg("user", "x")]));
      const settled = p.then(
        (v) => v,
        (e) => e,
      );
      await vi.advanceTimersByTimeAsync(60000);
      const err = await settled;

      expect(err).toBeInstanceOf(LLMRetryExhaustedError);
      const exhausted = err as LLMRetryExhaustedError;
      expect(exhausted.lastError).toBeInstanceOf(NetworkError);
    });

    it("throws InvalidResponseError on non-429 non-5xx HTTP error (immediate, no retry)", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response('{"error":"bad request"}', {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await expect(
        provider().chat(chatRequest([msg("user", "x")])),
      ).rejects.toThrow(InvalidResponseError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("throws InvalidResponseError when response body is not valid JSON", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response("not-json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await expect(
        provider().chat(chatRequest([msg("user", "x")])),
      ).rejects.toThrow(InvalidResponseError);
    });

    it("throws AbortedError when signal is already aborted", async () => {
      const ac = new AbortController();
      ac.abort();
      fetchMock.mockImplementationOnce(() =>
        Promise.reject(new DOMException("aborted", "AbortError")),
      );

      await expect(
        provider().chat(chatRequest([msg("user", "x")]), { signal: ac.signal }),
      ).rejects.toThrow(AbortedError);
    });

    it("passes AbortSignal to fetch", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          id: "x",
          choices: [
            {
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          model: "gpt-4o",
        }),
      );

      const ac = new AbortController();
      await provider().chat(chatRequest([msg("user", "x")]), {
        signal: ac.signal,
      });

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(init.signal).toBe(ac.signal);
    });

    it("tracks token usage with tokenBudget when provided", async () => {
      const tracked: unknown[] = [];
      const budget = {
        track: (u: unknown) => {
          tracked.push(u);
        },
        check: () => {},
      };

      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          id: "x",
          choices: [
            {
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          model: "gpt-4o",
        }),
      );

      await provider({ tokenBudget: budget }).chat(
        chatRequest([msg("user", "x")]),
      );

      expect(tracked).toHaveLength(1);
      const usage = tracked[0] as { totalTokens: number };
      expect(usage.totalTokens).toBe(15);
    });

    it("returns zero-value usage when response omits usage (OpenAI-compatible gateway)", async () => {
      // Many OpenAI-compatible gateways (local LLMs, vLLM, ollama, etc.)
      // omit `usage` entirely. We treat this as valid and return zeros
      // rather than crashing — see AGENTS.md exception for ecosystem compat.
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          id: "chatcmpl-1",
          choices: [
            {
              message: { role: "assistant", content: "Hello" },
              finish_reason: "stop",
            },
          ],
          model: "gpt-4o",
          // NOTE: no `usage` field
        }),
      );

      const res = await provider().chat(chatRequest([msg("user", "Hi")]));

      expect(res.content).toBe("Hello");
      expect(res.usage).toEqual({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      });
    });

    it("returns zero-value usage when response has usage: null", async () => {
      // Some gateways explicitly return `usage: null` instead of omitting it.
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          id: "chatcmpl-1",
          choices: [
            {
              message: { role: "assistant", content: "Hi" },
              finish_reason: "stop",
            },
          ],
          usage: null,
          model: "gpt-4o",
        }),
      );

      const res = await provider().chat(chatRequest([msg("user", "Hi")]));

      expect(res.content).toBe("Hi");
      expect(res.usage).toEqual({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      });
    });
  });

  describe("stream()", () => {
    it("parses OpenAI SSE stream and yields ChatChunks", async () => {
      fetchMock.mockResolvedValueOnce(streamingResponse(OPENAI_SSE));

      const chunks: ChatChunk[] = [];
      for await (const chunk of provider().stream(
        chatRequest([msg("user", "weather?")]),
      )) {
        chunks.push(chunk);
      }

      // text deltas
      const textChunks = chunks.filter((c) => c.delta.content !== undefined);
      expect(textChunks).toHaveLength(2);
      expect(textChunks[0].delta.content).toBe("Hello");
      expect(textChunks[1].delta.content).toBe(" world");

      // tool call start: id + name
      const toolStartChunks = chunks.filter(
        (c) => c.delta.toolCall?.id !== undefined,
      );
      expect(toolStartChunks).toHaveLength(1);
      expect(toolStartChunks[0].delta.toolCall?.id).toBe("call_abc");
      expect(toolStartChunks[0].delta.toolCall?.name).toBe("get_weather");

      // tool call arguments: accumulated and parsed once complete
      const toolArgChunks = chunks.filter(
        (c) => c.delta.toolCall?.arguments !== undefined,
      );
      expect(toolArgChunks).toHaveLength(1);
      expect(toolArgChunks[0].delta.toolCall?.arguments).toEqual({
        location: "SF",
      });

      // usage chunk
      const usageChunks = chunks.filter((c) => c.usage !== undefined);
      expect(usageChunks).toHaveLength(1);
      expect(usageChunks[0].usage).toEqual({
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
      });

      // finish_reason chunk
      const finishChunks = chunks.filter((c) => c.finishReason !== undefined);
      expect(finishChunks).toHaveLength(1);
      expect(finishChunks[0].finishReason).toBe("tool_calls");
    });

    it("sets stream:true in request body", async () => {
      fetchMock.mockResolvedValueOnce(streamingResponse(OPENAI_SSE));

      const iter = provider().stream(chatRequest([msg("user", "x")]));
      await iter[Symbol.asyncIterator]()
        .next()
        .catch(() => undefined);

      const body = JSON.parse(
        (fetchMock.mock.calls[0][1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      expect(body.stream).toBe(true);
    });

    it("passes AbortSignal to fetch in stream()", async () => {
      fetchMock.mockResolvedValueOnce(streamingResponse(OPENAI_SSE));

      const ac = new AbortController();
      const iter = provider().stream(chatRequest([msg("user", "x")]), {
        signal: ac.signal,
      });
      await iter[Symbol.asyncIterator]()
        .next()
        .catch(() => undefined);

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(init.signal).toBe(ac.signal);
    });

    it("throws InvalidResponseError when stream response body is null", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

      const iter = provider().stream(chatRequest([msg("user", "x")]));
      await expect(iter[Symbol.asyncIterator]().next()).rejects.toThrow(
        InvalidResponseError,
      );
    });

    it("throws AbortedError when signal already aborted in stream()", async () => {
      const ac = new AbortController();
      ac.abort();
      fetchMock.mockImplementationOnce(() =>
        Promise.reject(new DOMException("aborted", "AbortError")),
      );

      const iter = provider().stream(chatRequest([msg("user", "x")]), {
        signal: ac.signal,
      });
      await expect(iter[Symbol.asyncIterator]().next()).rejects.toThrow(
        AbortedError,
      );
    });

    it("handles stream with only text and finish_reason stop", async () => {
      const sse = [
        sseData({
          id: "chatcmpl-1",
          choices: [
            { index: 0, delta: { content: "hi" }, finish_reason: null },
          ],
        }),
        "",
        sseData({
          id: "chatcmpl-1",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }),
        "",
        "data: [DONE]",
        "",
        "",
      ].join("\n");

      fetchMock.mockResolvedValueOnce(streamingResponse(sse));

      const chunks: ChatChunk[] = [];
      for await (const c of provider().stream(
        chatRequest([msg("user", "x")]),
      )) {
        chunks.push(c);
      }

      const textChunks = chunks.filter((c) => c.delta.content !== undefined);
      expect(textChunks).toHaveLength(1);
      expect(textChunks[0].delta.content).toBe("hi");

      const finish = chunks.find((c) => c.finishReason !== undefined);
      expect(finish?.finishReason).toBe("stop");
    });

    it("tracks token usage from stream when tokenBudget provided", async () => {
      const tracked: unknown[] = [];
      const budget = {
        track: (u: unknown) => {
          tracked.push(u);
        },
        check: () => {},
      };

      fetchMock.mockResolvedValueOnce(streamingResponse(OPENAI_SSE));

      for await (const _ of provider({ tokenBudget: budget }).stream(
        chatRequest([msg("user", "x")]),
      )) {
        // drain
      }

      expect(tracked).toHaveLength(1);
      const usage = tracked[0] as { totalTokens: number };
      expect(usage.totalTokens).toBe(30);
    });

    it("yields no usage chunk when stream omits usage (OpenAI-compatible gateway)", async () => {
      // Stream that delivers content + finish_reason but no usage chunk.
      // OpenAI-compatible gateways (vLLM, ollama, local gateways) often do this.
      const sse = [
        sseData({
          id: "chatcmpl-1",
          choices: [
            { index: 0, delta: { content: "hi" }, finish_reason: null },
          ],
        }),
        "",
        sseData({
          id: "chatcmpl-1",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }),
        "",
        "data: [DONE]",
        "",
        "",
      ].join("\n");

      fetchMock.mockResolvedValueOnce(streamingResponse(sse));

      const chunks: ChatChunk[] = [];
      for await (const c of provider().stream(
        chatRequest([msg("user", "x")]),
      )) {
        chunks.push(c);
      }

      // Content chunks present
      const textChunks = chunks.filter((c) => c.delta.content !== undefined);
      expect(textChunks).toHaveLength(1);
      expect(textChunks[0].delta.content).toBe("hi");

      // No chunk should carry a usage field — CLI will show "(usage unavailable)"
      const usageChunks = chunks.filter((c) => c.usage !== undefined);
      expect(usageChunks).toHaveLength(0);
    });

    it("yields no usage chunk when stream contains usage: null", async () => {
      // Some gateways emit `usage: null` in the final chunk rather than omitting it.
      const sse = [
        sseData({
          id: "chatcmpl-1",
          choices: [
            { index: 0, delta: { content: "hi" }, finish_reason: null },
          ],
        }),
        "",
        sseData({
          id: "chatcmpl-1",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          // Explicit null — should be treated as "no usage"
          usage: null,
        }),
        "",
        "data: [DONE]",
        "",
        "",
      ].join("\n");

      fetchMock.mockResolvedValueOnce(streamingResponse(sse));

      const chunks: ChatChunk[] = [];
      for await (const c of provider().stream(
        chatRequest([msg("user", "x")]),
      )) {
        chunks.push(c);
      }

      // No chunk should carry a usable usage field
      const usageChunks = chunks.filter((c) => c.usage !== undefined);
      expect(usageChunks).toHaveLength(0);
    });
  });

  describe("embed()", () => {
    it("sends correct request and maps response", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: [{ embedding: [0.1, 0.2, 0.3] }],
          usage: { prompt_tokens: 5, total_tokens: 5 },
          model: "text-embedding-3-small",
        }),
      );

      const res = await provider({ model: "text-embedding-3-small" }).embed(
        "hello",
      );

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.openai.com/v1/embeddings");
      expect(init.method).toBe("POST");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-key");

      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.model).toBe("text-embedding-3-small");
      expect(body.input).toBe("hello");

      expect(res.embedding).toEqual([0.1, 0.2, 0.3]);
      expect(res.usage).toEqual({
        promptTokens: 5,
        completionTokens: 0,
        totalTokens: 5,
      });
      expect(res.model).toBe("text-embedding-3-small");
    });

    it("passes AbortSignal to fetch in embed()", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: [{ embedding: [0.1] }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
          model: "text-embedding-3-small",
        }),
      );

      const ac = new AbortController();
      await provider({ model: "text-embedding-3-small" }).embed("hi", {
        signal: ac.signal,
      });

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(init.signal).toBe(ac.signal);
    });

    it("maps HTTP 429 to RateLimitError (retried)", async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValue(
        new Response("{}", { status: 429, headers: { "Retry-After": "0" } }),
      );

      const p = provider().embed("hello");
      const settled = p.then(
        (v) => v,
        (e) => e,
      );
      await vi.advanceTimersByTimeAsync(60000);
      const err = (await settled) as LLMRetryExhaustedError;
      expect(err.lastError).toBeInstanceOf(RateLimitError);
    });

    it("throws InvalidResponseError when embed body is not valid JSON", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response("not-json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await expect(provider().embed("hi")).rejects.toThrow(
        InvalidResponseError,
      );
    });

    it("throws AbortedError when signal already aborted in embed()", async () => {
      const ac = new AbortController();
      ac.abort();
      fetchMock.mockImplementationOnce(() =>
        Promise.reject(new DOMException("aborted", "AbortError")),
      );

      await expect(
        provider().embed("hi", { signal: ac.signal }),
      ).rejects.toThrow(AbortedError);
    });
  });
});
