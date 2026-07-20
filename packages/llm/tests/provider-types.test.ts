import type { Message } from "@frogcode/core";
import { describe, expect, it } from "vitest";
import {
  AbortedError,
  type CallOptions,
  type ChatChunk,
  type ChatChunkDelta,
  type ChatRequest,
  type ChatResponse,
  type EmbedResponse,
  type FinishReason,
  InvalidResponseError,
  LLMError,
  type LLMProvider,
  LLMRetryExhaustedError,
  NetworkError,
  RateLimitError,
  type TokenUsage,
  type ToolCall,
  UnsupportedError,
} from "../src/index.js";

const ALL_FINISH_REASONS = [
  "stop",
  "tool_calls",
  "length",
  "content_filter",
] as const;

const baseMessage: Message = {
  id: "m-1",
  role: "user",
  content: "hello",
  timestamp: 1,
};

describe("CallOptions", () => {
  it("accepts an AbortSignal", () => {
    const ac = new AbortController();
    const opts: CallOptions = { signal: ac.signal };
    expect(opts.signal?.aborted).toBe(false);
  });

  it("treats signal as optional", () => {
    const opts: CallOptions = {};
    expect(opts.signal).toBeUndefined();
  });
});

describe("FinishReason", () => {
  it("includes all four documented reasons", () => {
    const reasons: FinishReason[] = [...ALL_FINISH_REASONS];
    expect(reasons).toHaveLength(4);
  });

  it("is the literal union stop | tool_calls | length | content_filter", () => {
    const literals: FinishReason[] = [
      "stop",
      "tool_calls",
      "length",
      "content_filter",
    ];
    for (const r of literals) expect(ALL_FINISH_REASONS).toContain(r);
  });
});

describe("ToolCall", () => {
  it("instantiates with id, name, arguments", () => {
    const tc: ToolCall = {
      id: "call_1",
      name: "search",
      arguments: { query: "frog", top: 3 },
    };
    expect(tc.id).toBe("call_1");
    expect(tc.name).toBe("search");
    expect(tc.arguments).toEqual({ query: "frog", top: 3 });
  });

  it("allows arbitrary JSON-shaped arguments", () => {
    const tc: ToolCall = {
      id: "c2",
      name: "noop",
      arguments: { nested: { a: [1, 2, 3] }, flag: true, missing: null },
    };
    expect(tc.arguments.nested).toEqual({ a: [1, 2, 3] });
  });
});

describe("TokenUsage", () => {
  it("instantiates with the three token counts", () => {
    const usage: TokenUsage = {
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    };
    expect(usage.promptTokens + usage.completionTokens).toBe(usage.totalTokens);
  });
});

describe("ChatRequest", () => {
  it("accepts messages and model", () => {
    const req: ChatRequest = {
      messages: [baseMessage],
      model: "gpt-4o-mini",
    };
    expect(req.messages).toHaveLength(1);
    expect(req.model).toBe("gpt-4o-mini");
  });

  it("accepts optional temperature / maxTokens / tools / signal", () => {
    const req: ChatRequest = {
      messages: [baseMessage],
      model: "gpt-4o-mini",
      temperature: 0.2,
      maxTokens: 256,
      tools: [
        {
          name: "search",
          description: "search the web",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
      ],
    };
    expect(req.temperature).toBe(0.2);
    expect(req.maxTokens).toBe(256);
    expect(req.tools?.[0]?.name).toBe("search");
  });
});

describe("ChatResponse", () => {
  it("instantiates with content, usage, finishReason", () => {
    const resp: ChatResponse = {
      content: "hi back",
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      finishReason: "stop",
      model: "gpt-4o-mini",
    };
    expect(resp.finishReason).toBe("stop");
    expect(resp.content).toBe("hi back");
  });

  it("accepts optional toolCalls array", () => {
    const resp: ChatResponse = {
      content: "",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "tool_calls",
      model: "gpt-4o-mini",
      toolCalls: [{ id: "tc-1", name: "lookup", arguments: { x: 1 } }],
    };
    expect(resp.toolCalls).toHaveLength(1);
  });
});

describe("ChatChunkDelta", () => {
  it("supports optional content", () => {
    const d: ChatChunkDelta = { content: "hel" };
    expect(d.content).toBe("hel");
    expect(d.toolCall).toBeUndefined();
  });

  it("supports optional Partial<ToolCall>", () => {
    const d: ChatChunkDelta = { toolCall: { id: "tc-1" } };
    expect(d.toolCall?.id).toBe("tc-1");
  });
});

describe("ChatChunk", () => {
  it("requires a delta", () => {
    const chunk: ChatChunk = { delta: { content: "lo" } };
    expect(chunk.delta.content).toBe("lo");
  });

  it("accepts optional usage and finishReason", () => {
    const chunk: ChatChunk = {
      delta: {},
      usage: { promptTokens: 0, completionTokens: 5, totalTokens: 5 },
      finishReason: "length",
    };
    expect(chunk.finishReason).toBe("length");
  });
});

describe("EmbedResponse", () => {
  it("carries vector and usage/model metadata", () => {
    const emb: EmbedResponse = {
      embedding: [0.1, 0.2, 0.3],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 3 },
      model: "text-embedding-3-small",
    };
    expect(emb.embedding).toHaveLength(3);
    expect(emb.model).toBe("text-embedding-3-small");
  });
});

describe("LLMProvider interface", () => {
  it("can be implemented by a stub", async () => {
    const stub: LLMProvider = {
      async chat(req, _opts) {
        const usage: TokenUsage = {
          promptTokens: 1,
          completionTokens: req.messages.length,
          totalTokens: 1 + req.messages.length,
        };
        const resp: ChatResponse = {
          content: "ok",
          usage,
          finishReason: "stop",
          model: req.model,
        };
        return resp;
      },
      async *stream(req, _opts) {
        const c: ChatChunk = { delta: { content: "ok" } };
        yield c;
        const tail: ChatChunk = {
          delta: {},
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: "stop",
        };
        yield tail;
      },
      async embed(text, _opts) {
        const emb: EmbedResponse = {
          embedding: [text.length],
          usage: {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: text.length,
          },
          model: "embed-stub",
        };
        return emb;
      },
    };
    const r = await stub.chat({ messages: [baseMessage], model: "m" });
    expect(r.content).toBe("ok");
    const collected: ChatChunk[] = [];
    for await (const c of stub.stream({
      messages: [baseMessage],
      model: "m",
    })) {
      collected.push(c);
    }
    expect(collected).toHaveLength(2);
    const e = await stub.embed("hi");
    expect(e.embedding).toEqual([2]);
  });
});

describe("LLMError hierarchy", () => {
  it("LLMError is an Error and the base of all subclasses", () => {
    const e = new LLMError("base");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(LLMError);
    expect(e.name).toBe("LLMError");
    expect(e.message).toBe("base");
  });

  it("each subclass sets its own name", () => {
    expect(new RateLimitError("r").name).toBe("RateLimitError");
    expect(new NetworkError("n").name).toBe("NetworkError");
    expect(new AbortedError("a").name).toBe("AbortedError");
    expect(new InvalidResponseError("i").name).toBe("InvalidResponseError");
    expect(new UnsupportedError("u").name).toBe("UnsupportedError");
    expect(new LLMRetryExhaustedError(new Error("x"), 3).name).toBe(
      "LLMRetryExhaustedError",
    );
  });

  it("every subclass is also an LLMError and Error", () => {
    const base = new Error("x");
    const errs = [
      new LLMError("a"),
      new RateLimitError("b"),
      new NetworkError("c"),
      new AbortedError("d"),
      new InvalidResponseError("e"),
      new UnsupportedError("f"),
      new LLMRetryExhaustedError(base, 3),
    ];
    for (const e of errs) {
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(LLMError);
    }
  });

  it("RateLimitError carries optional retryAfter", () => {
    const e1 = new RateLimitError("r", { retryAfter: 12 });
    expect(e1.retryAfter).toBe(12);
    const e2 = new RateLimitError("r");
    expect(e2.retryAfter).toBeUndefined();
  });

  it("LLMRetryExhaustedError wraps the last error and attempt count, and exposes RetryExhaustedMarker", () => {
    const last = new RateLimitError("rate", { retryAfter: 5 });
    const wrapped = new LLMRetryExhaustedError(last, 3);
    expect(wrapped.lastError).toBe(last);
    expect(wrapped.attempts).toBe(3);
    expect(wrapped.retryExhausted).toBe(true);
  });

  it("LLMRetryExhaustedError satisfies the structural RetryExhaustedMarker shape", () => {
    const wrapped = new LLMRetryExhaustedError(new Error("x"), 1);
    // Structural check: matches { readonly retryExhausted: true }
    const marker: { readonly retryExhausted: true } = wrapped;
    expect(marker.retryExhausted).toBe(true);
  });
});
