import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@frogcode/core";
import type { ExecutionContext, PRAOHandlers } from "@frogcode/core";
import type { Message } from "@frogcode/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLLMHandlers } from "../src/bridge/create-handlers.js";
import { EchoActHandler } from "../src/bridge/echo-act.js";
import { LLMObserveHandler } from "../src/bridge/llm-observe.js";
import { LLMPerceiveHandler } from "../src/bridge/llm-perceive.js";
import { LLMReasonHandler } from "../src/bridge/llm-reason.js";
import type { LLMHandlersOptions } from "../src/bridge/types.js";
import { PromptTemplate } from "../src/prompt/template.js";
import type { LLMProvider } from "../src/provider/interface.js";
import type {
  SchemaValidator,
  ValidationError,
  ValidationResult,
} from "../src/schema/types.js";
import {
  ValidationChain,
  ValidationExhaustedError,
} from "../src/schema/validation-chain.js";
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
  tempDir = await mkdtemp(join(tmpdir(), "frogcode-bridge-"));
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = "" as string;
  }
});

function makeMessage(content: string, role: Message["role"] = "user"): Message {
  return { id: `m-${Math.random()}`, role, content, timestamp: Date.now() };
}

function makeChatResponse(overrides: Partial<ChatResponse> = {}): ChatResponse {
  return {
    content: "mock-content",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    finishReason: "stop",
    model: "mock-model",
    ...overrides,
  };
}

function makeMockProvider(
  chatImpl?: (req: ChatRequest) => Promise<ChatResponse>,
): LLMProvider & { chat: ReturnType<typeof vi.fn> } {
  return {
    chat: vi.fn(chatImpl ?? (() => Promise.resolve(makeChatResponse()))),
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
  } as unknown as ExecutionContext;
}

// ---------------------------------------------------------------------------
// createLLMHandlers factory
// ---------------------------------------------------------------------------

describe("createLLMHandlers", () => {
  it("returns a PRAOHandlers with all four handler instances", () => {
    const provider = makeMockProvider();
    const handlers = createLLMHandlers(provider, { model: "mock" });

    expect(handlers.perceive).toBeInstanceOf(LLMPerceiveHandler);
    expect(handlers.reason).toBeInstanceOf(LLMReasonHandler);
    expect(handlers.act).toBeInstanceOf(EchoActHandler);
    expect(handlers.observe).toBeInstanceOf(LLMObserveHandler);
  });

  it("satisfies the PRAOHandlers interface structurally", () => {
    const provider = makeMockProvider();
    const handlers: PRAOHandlers = createLLMHandlers(provider, {
      model: "mock",
    });
    expect(handlers.perceive).toBeDefined();
    expect(handlers.reason).toBeDefined();
    expect(handlers.act).toBeDefined();
    expect(handlers.observe).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// LLMPerceiveHandler
// ---------------------------------------------------------------------------

describe("LLMPerceiveHandler", () => {
  it("builds a ChatRequest with the prompt as user message content", async () => {
    const provider = makeMockProvider();
    const handler = new LLMPerceiveHandler(provider, { model: "mock-model" });

    await handler.perceive({ prompt: "hello world" }, makeCtx());

    expect(provider.chat).toHaveBeenCalledTimes(1);
    const req = provider.chat.mock.calls[0]?.[0] as ChatRequest;
    expect(req.model).toBe("mock-model");
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]?.role).toBe("user");
    expect(req.messages[0]?.content).toBe("hello world");
  });

  it("passes ctx.signal through to provider.chat", async () => {
    const provider = makeMockProvider();
    const handler = new LLMPerceiveHandler(provider, { model: "mock" });
    const ctx = makeCtx();
    const ac = new AbortController();
    const steppedCtx = ctx.withSignal(ac.signal);

    await handler.perceive({ prompt: "x" }, steppedCtx);

    const opts = provider.chat.mock.calls[0]?.[1] as { signal: AbortSignal };
    expect(opts.signal).toBe(ac.signal);
  });

  it("returns the ChatResponse.content as the perception", async () => {
    const provider = makeMockProvider(() =>
      Promise.resolve(makeChatResponse({ content: "perceived!" })),
    );
    const handler = new LLMPerceiveHandler(provider, { model: "mock" });

    const perception = await handler.perceive({ prompt: "in" }, makeCtx());

    expect(perception).toBe("perceived!");
  });

  it("renders a registered 'perceive' prompt template when present", async () => {
    const provider = makeMockProvider();
    const template = PromptTemplate.compile("INSTRUCTIONS: {{prompt}}");
    const registry = new Map([["perceive", template]]);
    const handler = new LLMPerceiveHandler(provider, {
      model: "mock",
      promptRegistry: registry,
    });

    await handler.perceive({ prompt: "do thing" }, makeCtx());

    const req = provider.chat.mock.calls[0]?.[0] as ChatRequest;
    expect(req.messages[0]?.content).toBe("INSTRUCTIONS: do thing");
  });
});

// ---------------------------------------------------------------------------
// LLMReasonHandler
// ---------------------------------------------------------------------------

describe("LLMReasonHandler", () => {
  it("builds a ChatRequest with perception as user message", async () => {
    const provider = makeMockProvider();
    const handler = new LLMReasonHandler(provider, { model: "mock" });

    await handler.reason("the perception", makeCtx());

    const req = provider.chat.mock.calls[0]?.[0] as ChatRequest;
    expect(req.model).toBe("mock");
    expect(req.messages[0]?.role).toBe("user");
    expect(req.messages[0]?.content).toBe("the perception");
  });

  it("returns action=content and done=true when finishReason is 'stop'", async () => {
    const provider = makeMockProvider(() =>
      Promise.resolve(
        makeChatResponse({ content: "final answer", finishReason: "stop" }),
      ),
    );
    const handler = new LLMReasonHandler(provider, { model: "mock" });

    const result = await handler.reason("p", makeCtx());

    expect(result).toEqual({ action: "final answer", done: true });
  });

  it("returns action=content and done=false when finishReason is 'length'", async () => {
    const provider = makeMockProvider(() =>
      Promise.resolve(
        makeChatResponse({ content: "partial", finishReason: "length" }),
      ),
    );
    const handler = new LLMReasonHandler(provider, { model: "mock" });

    const result = await handler.reason("p", makeCtx());

    expect(result).toEqual({ action: "partial", done: false });
  });

  it("returns action=firstToolCall and done=false when toolCalls present and no validator", async () => {
    const toolCall: ToolCall = {
      id: "call-1",
      name: "search",
      arguments: { query: "foo" },
    };
    const provider = makeMockProvider(() =>
      Promise.resolve(
        makeChatResponse({
          content: "",
          finishReason: "tool_calls",
          toolCalls: [toolCall],
        }),
      ),
    );
    const handler = new LLMReasonHandler(provider, { model: "mock" });

    const result = await handler.reason("p", makeCtx());

    expect(result.done).toBe(false);
    expect(result.action).toEqual(toolCall);
  });

  it("passes ctx.signal through to provider.chat", async () => {
    const provider = makeMockProvider();
    const handler = new LLMReasonHandler(provider, { model: "mock" });
    const ctx = makeCtx();
    const ac = new AbortController();
    const steppedCtx = ctx.withSignal(ac.signal);

    await handler.reason("p", steppedCtx);

    const opts = provider.chat.mock.calls[0]?.[1] as { signal: AbortSignal };
    expect(opts.signal).toBe(ac.signal);
  });

  it("includes tools in the ChatRequest when provided via options", async () => {
    const provider = makeMockProvider();
    const tools: ToolDefinition[] = [
      {
        name: "search",
        description: "search the web",
        parameters: { type: "object" },
      },
    ];
    const handler = new LLMReasonHandler(provider, {
      model: "mock",
      tools,
    });

    await handler.reason("p", makeCtx());

    const req = provider.chat.mock.calls[0]?.[0] as ChatRequest;
    expect(req.tools).toEqual(tools);
  });

  it("does not set tools on the request when not provided", async () => {
    const provider = makeMockProvider();
    const handler = new LLMReasonHandler(provider, { model: "mock" });

    await handler.reason("p", makeCtx());

    const req = provider.chat.mock.calls[0]?.[0] as ChatRequest;
    expect(req.tools).toBeUndefined();
  });

  // -- schema validation path -------------------------------------------------

  it("validates toolCall arguments with schemaValidator when provided", async () => {
    const toolCall: ToolCall = {
      id: "call-1",
      name: "search",
      arguments: { query: "foo" },
    };
    const provider = makeMockProvider(() =>
      Promise.resolve(
        makeChatResponse({
          content: "",
          finishReason: "tool_calls",
          toolCalls: [toolCall],
        }),
      ),
    );
    const validator: SchemaValidator = {
      validate: vi.fn((data: unknown) => ({
        valid: true,
        errors: [],
        data,
      })),
    };
    const handler = new LLMReasonHandler(provider, {
      model: "mock",
      schemaValidator: validator,
      maxValidationAttempts: 3,
    });

    const result = await handler.reason("p", makeCtx());

    expect(validator.validate).toHaveBeenCalledTimes(1);
    expect(validator.validate).toHaveBeenCalledWith(toolCall.arguments);
    const action = result.action as ToolCall;
    expect(action.name).toBe("search");
    expect(action.arguments).toEqual({ query: "foo" });
    expect(result.done).toBe(false);
  });

  it("re-prompts the LLM with errors when validation fails, then succeeds", async () => {
    const goodArgs = { query: "valid" };
    const badArgs = { query: 123 };
    const badCall: ToolCall = {
      id: "call-1",
      name: "search",
      arguments: badArgs,
    };
    const goodCall: ToolCall = {
      id: "call-2",
      name: "search",
      arguments: goodArgs,
    };

    // First chat returns bad args, second returns good args.
    let callNum = 0;
    const provider = makeMockProvider(() => {
      callNum += 1;
      if (callNum === 1) {
        return Promise.resolve(
          makeChatResponse({
            content: "",
            finishReason: "tool_calls",
            toolCalls: [badCall],
          }),
        );
      }
      return Promise.resolve(
        makeChatResponse({
          content: "",
          finishReason: "tool_calls",
          toolCalls: [goodCall],
        }),
      );
    });

    const validator: SchemaValidator = {
      validate: vi.fn((data: unknown) => {
        const d = data as { query: unknown };
        if (typeof d.query === "string") {
          return { valid: true, errors: [], data };
        }
        const err: ValidationError = {
          path: "query",
          message: "must be string",
          expected: "string",
          received: typeof d.query,
        };
        return { valid: false, errors: [err] };
      }),
    };

    const handler = new LLMReasonHandler(provider, {
      model: "mock",
      schemaValidator: validator,
      maxValidationAttempts: 3,
    });

    const result = await handler.reason("initial perception", makeCtx());

    expect(provider.chat).toHaveBeenCalledTimes(2);
    // second call should include the validation errors in the user message
    const secondReq = provider.chat.mock.calls[1]?.[0] as ChatRequest;
    expect(secondReq.messages[0]?.content).toContain("must be string");
    const action = result.action as ToolCall;
    expect(action.arguments).toEqual(goodArgs);
  });

  it("throws ValidationExhaustedError when all attempts fail", async () => {
    const badCall: ToolCall = {
      id: "call-1",
      name: "search",
      arguments: { query: 123 },
    };
    const provider = makeMockProvider(() =>
      Promise.resolve(
        makeChatResponse({
          content: "",
          finishReason: "tool_calls",
          toolCalls: [badCall],
        }),
      ),
    );
    const validator: SchemaValidator = {
      validate: () => ({
        valid: false,
        errors: [
          {
            path: "query",
            message: "must be string",
            expected: "string",
            received: "number",
          },
        ],
      }),
    };

    const handler = new LLMReasonHandler(provider, {
      model: "mock",
      schemaValidator: validator,
      maxValidationAttempts: 2,
    });

    await expect(handler.reason("p", makeCtx())).rejects.toBeInstanceOf(
      ValidationExhaustedError,
    );
    // 1 initial + (maxAttempts - 1) retries = 2 total chat calls
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  it("uses default maxValidationAttempts of 3 when validator provided but no attempts", async () => {
    const badCall: ToolCall = {
      id: "call-1",
      name: "search",
      arguments: { query: 123 },
    };
    const provider = makeMockProvider(() =>
      Promise.resolve(
        makeChatResponse({
          content: "",
          finishReason: "tool_calls",
          toolCalls: [badCall],
        }),
      ),
    );
    const validator: SchemaValidator = {
      validate: () => ({
        valid: false,
        errors: [
          {
            path: "query",
            message: "must be string",
            expected: "string",
            received: "number",
          },
        ],
      }),
    };

    const handler = new LLMReasonHandler(provider, {
      model: "mock",
      schemaValidator: validator,
    });

    await expect(handler.reason("p", makeCtx())).rejects.toBeInstanceOf(
      ValidationExhaustedError,
    );
    // 1 initial + 2 retries = 3 total
    expect(provider.chat).toHaveBeenCalledTimes(3);
  });

  it("ValidationChain integration — honours maxValidationAttempts", async () => {
    // Sanity: ValidationChain directly with 1 attempt fails immediately
    const validator: SchemaValidator = {
      validate: () => ({
        valid: false,
        errors: [
          {
            path: "x",
            message: "bad",
            expected: "string",
            received: "number",
          },
        ],
      }),
    };
    const chain = new ValidationChain({ validator, maxAttempts: 1 });
    await expect(
      chain.validateWithRetry("foo", () => Promise.resolve("bar")),
    ).rejects.toBeInstanceOf(ValidationExhaustedError);
  });
});

// ---------------------------------------------------------------------------
// EchoActHandler
// ---------------------------------------------------------------------------

describe("EchoActHandler", () => {
  it("returns the decision unchanged", async () => {
    const handler = new EchoActHandler();
    const decision = { action: "do-thing", payload: 42 };
    const result = await handler.act(decision, makeCtx());
    expect(result).toBe(decision);
  });

  it("returns primitive decisions unchanged", async () => {
    const handler = new EchoActHandler();
    expect(await handler.act("a string", makeCtx())).toBe("a string");
    expect(await handler.act(123, makeCtx())).toBe(123);
    expect(await handler.act(null, makeCtx())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LLMObserveHandler
// ---------------------------------------------------------------------------

describe("LLMObserveHandler", () => {
  it("returns ObserveResult with content as String(actionResult)", async () => {
    const handler = new LLMObserveHandler();
    const result = await handler.observe(
      { action: "search" },
      "the result string",
      makeCtx(),
    );
    expect(result.content).toBe("the result string");
  });

  it("stringifies non-string actionResult", async () => {
    const handler = new LLMObserveHandler();
    const result = await handler.observe("decision", { count: 5 }, makeCtx());
    expect(result.content).toBe(String({ count: 5 }));
  });

  it("stringifies primitive actionResult", async () => {
    const handler = new LLMObserveHandler();
    const result = await handler.observe("d", 42, makeCtx());
    expect(result.content).toBe("42");
  });
});

// ---------------------------------------------------------------------------
// LLMHandlersOptions
// ---------------------------------------------------------------------------

describe("LLMHandlersOptions", () => {
  it("allows omitting all optional fields", () => {
    const opts: LLMHandlersOptions = { model: "m" };
    expect(opts.model).toBe("m");
    expect(opts.promptRegistry).toBeUndefined();
    expect(opts.schemaValidator).toBeUndefined();
    expect(opts.maxValidationAttempts).toBeUndefined();
    expect(opts.tools).toBeUndefined();
  });

  it("accepts all fields", () => {
    const validator: SchemaValidator = {
      validate: () => ({ valid: true, errors: [] }),
    };
    const opts: LLMHandlersOptions = {
      model: "gpt-4",
      promptRegistry: new Map([
        ["perceive", PromptTemplate.compile("{{prompt}}")],
      ]),
      schemaValidator: validator,
      maxValidationAttempts: 5,
      tools: [{ name: "t", description: "d", parameters: {} }],
    };
    expect(opts.model).toBe("gpt-4");
    expect(opts.maxValidationAttempts).toBe(5);
    expect(opts.tools).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Integration: full PRAO cycle with Agent + ExecutionLoop
// ---------------------------------------------------------------------------

describe("integration: createLLMHandlers with Agent", () => {
  it("runs a complete PRAO cycle with a mock provider", async () => {
    const provider = makeMockProvider(() =>
      Promise.resolve(
        makeChatResponse({
          content: "hello from llm",
          finishReason: "stop",
        }),
      ),
    );
    const handlers = createLLMHandlers(provider, { model: "mock" });
    const agent = Agent.create({
      name: "bridge-test",
      eventsBasePath: tempDir,
      handlers,
    });

    const output = await agent.run({ prompt: "hi" });

    expect(agent.state).toBe("finished");
    // Should have at least one full PRAO cycle (4 steps)
    const types = output.steps.map((s) => s.type);
    expect(types).toEqual(["perceive", "reason", "act", "observe"]);
    // The reason step should have returned the LLM content as the action
    const reasonStep = output.steps.find((s) => s.type === "reason");
    expect(reasonStep?.output).toEqual({
      action: "hello from llm",
      done: true,
    });
    // The observe step should have content = String(echoed decision)
    const observeStep = output.steps.find((s) => s.type === "observe");
    expect(observeStep?.output).toEqual({
      content: "hello from llm",
    });
  });

  it("provider.chat receives ctx.signal via the bridge", async () => {
    const provider = makeMockProvider();
    const handlers = createLLMHandlers(provider, { model: "mock" });
    const agent = Agent.create({
      name: "signal-test",
      eventsBasePath: tempDir,
      handlers,
    });

    await agent.run({ prompt: "hi" });

    // Every chat call should have been passed a signal
    for (const call of provider.chat.mock.calls) {
      const opts = call[1] as { signal: AbortSignal } | undefined;
      expect(opts?.signal).toBeInstanceOf(AbortSignal);
    }
  });
});
