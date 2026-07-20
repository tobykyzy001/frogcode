import type { Message } from "@frogcode/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "../src/adapters/anthropic.js";
import {
  AbortedError,
  InvalidResponseError,
  LLMRetryExhaustedError,
  NetworkError,
  RateLimitError,
  UnsupportedError,
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

function chatRequest(messages: Message[]): ChatRequest {
  return { model: "claude-3-5-sonnet-20241022", messages };
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

const ANTHROPIC_SSE = [
  "event: message_start",
  'data: {"type":"message_start","message":{"id":"msg_1","role":"assistant","content":[],"model":"claude-3-5-sonnet-20241022","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}',
  "",
  "event: content_block_start",
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
  "",
  "event: content_block_stop",
  'data: {"type":"content_block_stop","index":0}',
  "",
  "event: content_block_start",
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_123","name":"get_weather","input":{}}}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"location\\":\\"SF\\"}"}}',
  "",
  "event: content_block_stop",
  'data: {"type":"content_block_stop","index":1}',
  "",
  "event: message_delta",
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":15}}',
  "",
  "event: message_stop",
  'data: {"type":"message_stop"}',
  "",
  "",
].join("\n");

// ---------- tests ----------

describe("AnthropicProvider", () => {
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
    tokenBudget?: { track: (u: unknown) => void; check: () => void };
  }): AnthropicProvider {
    return new AnthropicProvider({
      apiKey: "test-key",
      model: "claude-3-5-sonnet-20241022",
      baseURL: opts?.baseURL,
      // biome-ignore lint/suspicious/noExplicitAny: test-only fake budget
      tokenBudget: opts?.tokenBudget as never,
    });
  }

  describe("constructor", () => {
    it("defaults baseURL to https://api.anthropic.com/v1", () => {
      const p = provider();
      expect(p.baseURL).toBe("https://api.anthropic.com/v1");
    });

    it("uses provided baseURL when given", () => {
      const p = provider({ baseURL: "https://custom.example.com" });
      expect(p.baseURL).toBe("https://custom.example.com");
    });

    it("exposes apiKey and model", () => {
      const p = provider();
      expect(p.apiKey).toBe("test-key");
      expect(p.model).toBe("claude-3-5-sonnet-20241022");
    });
  });

  describe("chat()", () => {
    it("extracts system message to top-level system field and removes it from messages", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          content: [{ type: "text", text: "Hi there" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
          model: "claude-3-5-sonnet-20241022",
        }),
      );

      await provider().chat(
        chatRequest([msg("system", "You are helpful."), msg("user", "Hi")]),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0];
      const url = call[0] as string;
      const init = call[1] as RequestInit;
      expect(url).toBe("https://api.anthropic.com/v1/messages");

      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.system).toBe("You are helpful.");
      expect(body.messages).toEqual([{ role: "user", content: "Hi" }]);
      const messages = body.messages as Array<{ role: string }>;
      expect(messages.find((m) => m.role === "system")).toBeUndefined();
      expect(body.model).toBe("claude-3-5-sonnet-20241022");
    });

    it("sends x-api-key, anthropic-version, and Content-Type headers", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
          model: "claude-3-5-sonnet-20241022",
        }),
      );

      await provider().chat(chatRequest([msg("user", "hi")]));

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("test-key");
      expect(headers["anthropic-version"]).toBe("2023-06-01");
      expect(headers["Content-Type"]).toBe("application/json");
    });

    it("defaults max_tokens to 4096 when not specified", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
          model: "claude-3-5-sonnet-20241022",
        }),
      );

      await provider().chat(chatRequest([msg("user", "hi")]));

      const body = JSON.parse(
        (fetchMock.mock.calls[0][1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      expect(body.max_tokens).toBe(4096);
    });

    it("passes max_tokens from request when provided", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
          model: "claude-3-5-sonnet-20241022",
        }),
      );

      await provider().chat({
        model: "claude-3-5-sonnet-20241022",
        messages: [msg("user", "hi")],
        maxTokens: 100,
      });

      const body = JSON.parse(
        (fetchMock.mock.calls[0][1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      expect(body.max_tokens).toBe(100);
    });

    it("passes temperature when provided", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
          model: "claude-3-5-sonnet-20241022",
        }),
      );

      await provider().chat({
        model: "claude-3-5-sonnet-20241022",
        messages: [msg("user", "hi")],
        temperature: 0.7,
      });

      const body = JSON.parse(
        (fetchMock.mock.calls[0][1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      expect(body.temperature).toBe(0.7);
    });

    it("maps text content blocks to ChatResponse.content (concatenated)", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          content: [
            { type: "text", text: "Hello" },
            { type: "text", text: " world" },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
          model: "claude-3-5-sonnet-20241022",
        }),
      );

      const res = await provider().chat(chatRequest([msg("user", "hi")]));

      expect(res.content).toBe("Hello world");
    });

    it("maps tool_use content blocks to ToolCall[]", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          content: [
            { type: "text", text: "Let me check." },
            {
              type: "tool_use",
              id: "toolu_abc",
              name: "get_weather",
              input: { location: "SF" },
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 20 },
          model: "claude-3-5-sonnet-20241022",
        }),
      );

      const res = await provider().chat(chatRequest([msg("user", "weather?")]));

      expect(res.toolCalls).toBeDefined();
      expect(res.toolCalls).toHaveLength(1);
      expect(res.toolCalls?.[0]).toEqual({
        id: "toolu_abc",
        name: "get_weather",
        arguments: { location: "SF" },
      });
    });

    it("maps stop_reason end_turn -> stop", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          content: [{ type: "text", text: "done" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
          model: "claude-3-5-sonnet-20241022",
        }),
      );

      const res = await provider().chat(chatRequest([msg("user", "x")]));
      expect(res.finishReason).toBe("stop");
    });

    it("maps stop_reason tool_use -> tool_calls", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "f",
              input: {},
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
          model: "claude-3-5-sonnet-20241022",
        }),
      );

      const res = await provider().chat(chatRequest([msg("user", "x")]));
      expect(res.finishReason).toBe("tool_calls");
    });

    it("maps stop_reason max_tokens -> length", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          content: [{ type: "text", text: "..." }],
          stop_reason: "max_tokens",
          usage: { input_tokens: 1, output_tokens: 1 },
          model: "claude-3-5-sonnet-20241022",
        }),
      );

      const res = await provider().chat(chatRequest([msg("user", "x")]));
      expect(res.finishReason).toBe("length");
    });

    it("maps usage: input_tokens -> promptTokens, output_tokens -> completionTokens, sum -> totalTokens", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 25, output_tokens: 15 },
          model: "claude-3-5-sonnet-20241022",
        }),
      );

      const res = await provider().chat(chatRequest([msg("user", "x")]));

      expect(res.usage).toEqual({
        promptTokens: 25,
        completionTokens: 15,
        totalTokens: 40,
      });
    });

    it("returns model from response", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
          model: "claude-3-5-sonnet-20241022",
        }),
      );

      const res = await provider().chat(chatRequest([msg("user", "x")]));
      expect(res.model).toBe("claude-3-5-sonnet-20241022");
    });

    it("omits toolCalls from ChatResponse when response has no tool_use blocks", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
          model: "claude-3-5-sonnet-20241022",
        }),
      );

      const res = await provider().chat(chatRequest([msg("user", "x")]));
      expect(res.toolCalls).toBeUndefined();
    });

    it("throws InvalidResponseError when response body is not valid JSON", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response("not json at all", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await expect(
        provider().chat(chatRequest([msg("user", "x")])),
      ).rejects.toThrow(InvalidResponseError);
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
      expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
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
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
          model: "claude-3-5-sonnet-20241022",
        }),
      );

      await provider({ tokenBudget: budget }).chat(
        chatRequest([msg("user", "x")]),
      );

      expect(tracked).toHaveLength(1);
      const usage = tracked[0] as { totalTokens: number };
      expect(usage.totalTokens).toBe(15);
    });

    it("returns zero-value usage when response omits usage (compat gateway)", async () => {
      // OpenAI-compatible/Anthropic-compatible gateways sometimes omit usage.
      // We return zeros instead of crashing — ecosystem compat exception.
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          content: [{ type: "text", text: "Hi" }],
          stop_reason: "end_turn",
          model: "claude-3-5-sonnet-20241022",
          // NOTE: no `usage` field
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

    it("returns zero-value usage when response has usage: null", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          content: [{ type: "text", text: "Hi" }],
          stop_reason: "end_turn",
          usage: null,
          model: "claude-3-5-sonnet-20241022",
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
    it("maps Anthropic SSE events to ChatChunk stream", async () => {
      fetchMock.mockResolvedValueOnce(streamingResponse(ANTHROPIC_SSE));

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

      // tool_use content_block_start -> id + name
      const toolStartChunks = chunks.filter(
        (c) => c.delta.toolCall?.id !== undefined,
      );
      expect(toolStartChunks).toHaveLength(1);
      expect(toolStartChunks[0].delta.toolCall?.id).toBe("toolu_123");
      expect(toolStartChunks[0].delta.toolCall?.name).toBe("get_weather");

      // input_json_delta -> arguments
      const toolArgChunks = chunks.filter(
        (c) => c.delta.toolCall?.arguments !== undefined,
      );
      expect(toolArgChunks).toHaveLength(1);
      expect(toolArgChunks[0].delta.toolCall?.arguments).toEqual({
        location: "SF",
      });

      // message_delta -> usage
      const usageChunks = chunks.filter((c) => c.usage !== undefined);
      expect(usageChunks).toHaveLength(1);
      expect(usageChunks[0].usage).toEqual({
        promptTokens: 10,
        completionTokens: 15,
        totalTokens: 25,
      });

      // message_stop -> finishReason
      const finishChunks = chunks.filter((c) => c.finishReason !== undefined);
      expect(finishChunks).toHaveLength(1);
      expect(finishChunks[0].finishReason).toBe("tool_calls");
    });

    it("sets stream: true in request body", async () => {
      fetchMock.mockResolvedValueOnce(streamingResponse(ANTHROPIC_SSE));

      const iter = provider().stream(chatRequest([msg("user", "x")]));
      await iter[Symbol.asyncIterator]()
        .next()
        .catch(() => undefined);

      const body = JSON.parse(
        (fetchMock.mock.calls[0][1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      expect(body.stream).toBe(true);
    });

    it("extracts system message to top-level system field in stream body", async () => {
      fetchMock.mockResolvedValueOnce(streamingResponse(ANTHROPIC_SSE));

      const iter = provider().stream(
        chatRequest([msg("system", "be nice"), msg("user", "x")]),
      );
      await iter[Symbol.asyncIterator]()
        .next()
        .catch(() => undefined);

      const body = JSON.parse(
        (fetchMock.mock.calls[0][1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      expect(body.system).toBe("be nice");
    });

    it("throws InvalidResponseError when stream response body is null", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

      const iter = provider().stream(chatRequest([msg("user", "x")]));
      await expect(iter[Symbol.asyncIterator]().next()).rejects.toThrow(
        InvalidResponseError,
      );
    });

    it("maps end_turn stop_reason in message_delta to finishReason 'stop'", async () => {
      const sse = [
        "event: message_start",
        'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}',
        "",
        "event: content_block_delta",
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
        "",
        "event: message_delta",
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
        "",
        "event: message_stop",
        'data: {"type":"message_stop"}',
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

      const finish = chunks.find((c) => c.finishReason !== undefined);
      expect(finish?.finishReason).toBe("stop");
    });
  });

  describe("embed()", () => {
    it("throws UnsupportedError mentioning embeddings", () => {
      const p = provider();
      expect(() => p.embed("text")).toThrow(UnsupportedError);
    });

    it("throws synchronously (does not return a rejected promise)", () => {
      const p = provider();
      // embed() per spec throws (not async-rejects). The interface declares
      // Promise<EmbedResponse> but the implementation throws synchronously,
      // which propagates as a rejected promise when awaited.
      expect(() => p.embed("text")).toThrow();
    });

    it("error message contains 'embeddings'", () => {
      const p = provider();
      try {
        p.embed("text");
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(UnsupportedError);
        expect((e as Error).message.toLowerCase()).toContain("embedding");
      }
    });
  });
});
