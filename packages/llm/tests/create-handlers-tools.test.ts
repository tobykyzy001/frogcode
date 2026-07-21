import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionContext } from "@frogcode/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLLMHandlers } from "../src/bridge/create-handlers.js";
import { EchoActHandler } from "../src/bridge/echo-act.js";
import { LLMObserveHandler } from "../src/bridge/llm-observe.js";
import { LLMPerceiveHandler } from "../src/bridge/llm-perceive.js";
import { LLMReasonHandler } from "../src/bridge/llm-reason.js";
import type { LLMProvider } from "../src/provider/interface.js";
import type {
  ChatRequest,
  ChatResponse,
  EmbedResponse,
  ToolCall,
  ToolDefinition,
} from "../src/types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "frogcode-create-handlers-tools-"));
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = "" as string;
  }
});

function makeChatResponse(overrides: Partial<ChatResponse> = {}): ChatResponse {
  return {
    content: "mock-content",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    finishReason: "stop",
    model: "mock-model",
    ...overrides,
  };
}

/**
 * Build a mock provider that records every ChatRequest it receives and
 * returns a configurable response. The `responseFor` hook lets each test
 * customize the response based on the request (e.g. emit tool calls when
 * tools are present).
 */
function makeRecordingProvider(
  responseFor?: (req: ChatRequest) => ChatResponse,
): LLMProvider & {
  chat: ReturnType<typeof vi.fn>;
  requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  const chat = vi.fn(async (req: ChatRequest) => {
    requests.push(req);
    if (responseFor) {
      return responseFor(req);
    }
    return makeChatResponse();
  });
  return {
    chat,
    requests,
    stream: async function* () {
      yield { delta: { content: "test" } };
    },
    embed: vi.fn(
      () =>
        Promise.resolve({
          embedding: [1, 2, 3],
          usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 },
          model: "mock",
        }) as Promise<EmbedResponse>,
    ),
  };
}

// A minimal ExecutionContext stub. The real class requires a state machine;
// for handler unit tests we only need signal + metadata + config shape.
function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  const ac = new AbortController();
  return {
    agentId: "test-agent",
    config: {
      name: "test",
      maxSteps: 10,
      stepTimeoutMs: 30000,
      maxRetries: 3,
      metadata: {},
      eventsBasePath: tempDir,
    },
    metadata: {},
    createdAt: Date.now(),
    signal: ac.signal,
    state: "running",
    set: () => {},
    get: () => undefined,
    has: () => false,
    createChild: () => makeCtx(),
    withSignal: (signal: AbortSignal) =>
      ({ ...makeCtx(), signal }) as ExecutionContext,
    toJSON: () => "{}",
    ...overrides,
  } as unknown as ExecutionContext;
}

// ---------------------------------------------------------------------------
// Backward compatibility (no toolRegistry)
// ---------------------------------------------------------------------------

describe("createLLMHandlers — backward compatibility (no toolRegistry)", () => {
  it("returns a complete PRAOHandlers when only `model` is supplied", () => {
    const provider = makeRecordingProvider();
    const handlers = createLLMHandlers(provider, { model: "gpt-4o" });

    expect(handlers.perceive).toBeInstanceOf(LLMPerceiveHandler);
    expect(handlers.reason).toBeInstanceOf(LLMReasonHandler);
    expect(handlers.act).toBeInstanceOf(EchoActHandler);
    expect(handlers.observe).toBeInstanceOf(LLMObserveHandler);
  });

  it("omits `tools` from ChatRequest when neither tools nor toolRegistry are set", async () => {
    const provider = makeRecordingProvider();
    const handlers = createLLMHandlers(provider, { model: "gpt-4o" });

    await handlers.reason.reason("hello", makeCtx());

    expect(provider.chat).toHaveBeenCalledTimes(1);
    const req = provider.requests[0];
    expect(req).toBeDefined();
    expect(req?.model).toBe("gpt-4o");
    expect(req?.tools).toBeUndefined();
  });

  it("forwards a static `tools` array unchanged when no registry is provided", async () => {
    const provider = makeRecordingProvider();
    const staticTools: ToolDefinition[] = [
      {
        name: "static.tool",
        description: "a static tool",
        parameters: { type: "object", properties: {} },
      },
    ];

    const handlers = createLLMHandlers(provider, {
      model: "gpt-4o",
      tools: staticTools,
    });

    await handlers.reason.reason("hello", makeCtx());

    const req = provider.requests[0];
    expect(req?.tools).toEqual(staticTools);
  });
});

// ---------------------------------------------------------------------------
// toolRegistry path
// ---------------------------------------------------------------------------

describe("createLLMHandlers — toolRegistry option", () => {
  it("passes tools from `toolRegistry.toLLMTools()` to the provider", async () => {
    const registryTools: ToolDefinition[] = [
      {
        name: "fs.read",
        description: "read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
      {
        name: "fs.write",
        description: "write a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    ];

    const provider = makeRecordingProvider();
    const toolRegistry = {
      toLLMTools: vi.fn(() => registryTools),
    };

    const handlers = createLLMHandlers(provider, {
      model: "gpt-4o",
      toolRegistry,
    });

    await handlers.reason.reason("hello", makeCtx());

    expect(toolRegistry.toLLMTools).toHaveBeenCalledTimes(1);
    expect(provider.chat).toHaveBeenCalledTimes(1);
    const req = provider.requests[0];
    expect(req?.tools).toEqual(registryTools);
    expect(req?.tools).toHaveLength(2);
  });

  it("invokes `toolRegistry.toLLMTools()` on every reason call (live view)", async () => {
    const provider = makeRecordingProvider();
    const callCounter = vi.fn(() => [] as ToolDefinition[]);

    const handlers = createLLMHandlers(provider, {
      model: "gpt-4o",
      toolRegistry: { toLLMTools: callCounter },
    });

    await handlers.reason.reason("first", makeCtx());
    await handlers.reason.reason("second", makeCtx());

    expect(callCounter).toHaveBeenCalledTimes(2);
  });

  it("accepts any object with a `toLLMTools()` method (structural typing)", async () => {
    // This test documents that the registry is typed structurally — passing
    // a plain object literal is enough; no base class or interface is required.
    const provider = makeRecordingProvider();
    const handlers = createLLMHandlers(provider, {
      model: "gpt-4o",
      toolRegistry: {
        toLLMTools: () => [
          {
            name: "ad-hoc",
            description: "ad-hoc tool",
            parameters: {},
          },
        ],
      },
    });

    await handlers.reason.reason("hello", makeCtx());

    expect(provider.requests[0]?.tools).toHaveLength(1);
    expect(provider.requests[0]?.tools?.[0]?.name).toBe("ad-hoc");
  });

  it("lets `toolRegistry` take precedence over a static `tools` array", async () => {
    const provider = makeRecordingProvider();
    const registryTools: ToolDefinition[] = [
      { name: "from-registry", description: "registry", parameters: {} },
    ];
    const staticTools: ToolDefinition[] = [
      { name: "from-static", description: "static", parameters: {} },
    ];

    const handlers = createLLMHandlers(provider, {
      model: "gpt-4o",
      tools: staticTools,
      toolRegistry: { toLLMTools: () => registryTools },
    });

    await handlers.reason.reason("hello", makeCtx());

    const req = provider.requests[0];
    expect(req?.tools).toEqual(registryTools);
    expect(req?.tools?.[0]?.name).toBe("from-registry");
  });
});

// ---------------------------------------------------------------------------
// onToolCall hook
// ---------------------------------------------------------------------------

describe("createLLMHandlers — onToolCall hook", () => {
  it("invokes onToolCall for each tool call returned by the LLM", async () => {
    const toolCalls: ToolCall[] = [
      { id: "call-1", name: "fs.read", arguments: { path: "/etc/hosts" } },
    ];

    const provider = makeRecordingProvider((req) => {
      // Emit tool calls when tools were sent; otherwise stay plain.
      if (req.tools && req.tools.length > 0) {
        return makeChatResponse({ toolCalls, finishReason: "tool_calls" });
      }
      return makeChatResponse();
    });

    const onToolCall = vi.fn();

    const handlers = createLLMHandlers(provider, {
      model: "gpt-4o",
      tools: [{ name: "fs.read", description: "read a file", parameters: {} }],
      onToolCall,
    });

    await handlers.reason.reason("hello", makeCtx());

    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onToolCall).toHaveBeenCalledWith(toolCalls[0]);
  });

  it("does not invoke onToolCall when the LLM response carries no tool calls", async () => {
    const provider = makeRecordingProvider(); // default: no tool calls
    const onToolCall = vi.fn();

    const handlers = createLLMHandlers(provider, {
      model: "gpt-4o",
      onToolCall,
    });

    await handlers.reason.reason("hello", makeCtx());

    expect(onToolCall).not.toHaveBeenCalled();
  });

  it("is invoked once per tool call when the LLM emits multiple calls", async () => {
    const toolCalls: ToolCall[] = [
      { id: "call-1", name: "fs.read", arguments: {} },
      { id: "call-2", name: "fs.write", arguments: {} },
      { id: "call-3", name: "fs.list", arguments: {} },
    ];

    const provider = makeRecordingProvider(() =>
      makeChatResponse({ toolCalls, finishReason: "tool_calls" }),
    );
    const onToolCall = vi.fn();

    const handlers = createLLMHandlers(provider, {
      model: "gpt-4o",
      onToolCall,
    });

    await handlers.reason.reason("hello", makeCtx());

    expect(onToolCall).toHaveBeenCalledTimes(3);
    expect(onToolCall).toHaveBeenNthCalledWith(1, toolCalls[0]);
    expect(onToolCall).toHaveBeenNthCalledWith(2, toolCalls[1]);
    expect(onToolCall).toHaveBeenNthCalledWith(3, toolCalls[2]);
  });
});
