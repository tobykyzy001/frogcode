import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  ExecutionContext,
  AgentStateMachine,
  createAgentConfig,
  type ActHandler,
} from "@frogcode/core";
import {
  createToolActHandler,
  ToolPipeline,
  ToolRegistry,
  PermissionEngine,
  createMockSandbox,
  createTool,
  type ToolCall,
  type ToolPipelineOptions,
  type ToolActionResult,
} from "../src/index.js";

/**
 * Build a real ExecutionContext for tests. The handler reads `ctx.signal`
 * and calls `ctx.get(...)`, so a plain-object cast would not satisfy the
 * `ExecutionContext` interface at runtime.
 */
function makeCtx(): ExecutionContext {
  const sm = new AgentStateMachine();
  sm.transition("running");
  return new ExecutionContext({
    agentId: "test-agent",
    config: createAgentConfig({ name: "test-agent" }),
    stateMachine: sm,
  });
}

/**
 * Build a ToolPipeline wired up with a real ToolRegistry + PermissionEngine
 * (in `auto-approve-all` mode so tests don't need to mock permission) + mock
 * sandbox (unused by the pipeline today but required by the constructor).
 */
function makePipeline(
  tools: ReadonlyArray<ReturnType<typeof createTool>> = [],
): ToolPipeline {
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t);
  const permission = new PermissionEngine({ mode: "auto-approve-all" });
  const sandbox = createMockSandbox();
  const opts: ToolPipelineOptions = { registry, permission, sandbox };
  return new ToolPipeline(opts);
}

const echoTool = () =>
  createTool({
    id: "test.echo",
    description: "echo the message back",
    inputSchema: z.object({ msg: z.string() }),
    outputSchema: z.object({ echoed: z.string() }),
    execute: async (input) => ({ echoed: input.msg }),
  });

const addTool = () =>
  createTool({
    id: "test.add",
    description: "add two numbers",
    inputSchema: z.object({ a: z.number(), b: z.number() }),
    outputSchema: z.object({ sum: z.number() }),
    execute: async (input) => ({ sum: input.a + input.b }),
  });

const upperTool = () =>
  createTool({
    id: "test.upper",
    description: "uppercase a string",
    inputSchema: z.object({ s: z.string() }),
    outputSchema: z.object({ out: z.string() }),
    execute: async (input) => ({ out: input.s.toUpperCase() }),
  });

describe("createToolActHandler — returns an ActHandler", () => {
  it("returns an object with an `act` function", () => {
    const pipeline = makePipeline();
    const handler = createToolActHandler(pipeline);
    expect(typeof handler).toBe("object");
    expect(typeof handler.act).toBe("function");
  });

  it("the returned handler satisfies the ActHandler interface", () => {
    const pipeline = makePipeline();
    const handler: ActHandler = createToolActHandler(pipeline);
    expect(handler.act).toBeInstanceOf(Function);
  });
});

describe("createToolActHandler — no tool calls", () => {
  it("returns immediately when decision has no `toolCalls` field", async () => {
    const pipeline = makePipeline();
    const handler = createToolActHandler(pipeline);
    const result = (await handler.act(
      { text: "no tool call" },
      makeCtx(),
    )) as ToolActionResult;
    expect(result.toolActResult.toolCallsMade).toBe(false);
    expect(result.toolActResult.toolResults).toHaveLength(0);
    expect(result.decision.text).toBe("no tool call");
  });

  it("returns immediately when decision is null", async () => {
    const pipeline = makePipeline();
    const handler = createToolActHandler(pipeline);
    const result = (await handler.act(null, makeCtx())) as ToolActionResult;
    expect(result.toolActResult.toolCallsMade).toBe(false);
    expect(result.toolActResult.toolResults).toHaveLength(0);
  });

  it("returns immediately when decision is undefined", async () => {
    const pipeline = makePipeline();
    const handler = createToolActHandler(pipeline);
    const result = (await handler.act(undefined, makeCtx())) as ToolActionResult;
    expect(result.toolActResult.toolCallsMade).toBe(false);
    expect(result.toolActResult.toolResults).toHaveLength(0);
  });

  it("returns immediately when `toolCalls` is an empty array", async () => {
    const pipeline = makePipeline();
    const handler = createToolActHandler(pipeline);
    const result = (await handler.act(
      { toolCalls: [] },
      makeCtx(),
    )) as ToolActionResult;
    expect(result.toolActResult.toolCallsMade).toBe(false);
    expect(result.toolActResult.toolResults).toHaveLength(0);
  });

  it("returns immediately when `toolCalls` is malformed (non-array)", async () => {
    const pipeline = makePipeline();
    const handler = createToolActHandler(pipeline);
    // Malformed decision: toolCalls is a string, not an array — should be
    // treated as "no tool calls" rather than throwing.
    const result = (await handler.act(
      { toolCalls: "not-an-array" },
      makeCtx(),
    )) as ToolActionResult;
    expect(result.toolActResult.toolCallsMade).toBe(false);
    expect(result.toolActResult.toolResults).toHaveLength(0);
  });
});

describe("createToolActHandler — executes tool calls", () => {
  it("executes a single toolCall and returns its result", async () => {
    const pipeline = makePipeline([echoTool()]);
    const handler = createToolActHandler(pipeline);
    const calls: ToolCall[] = [
      { id: "call-1", name: "test.echo", arguments: { msg: "hello" } },
    ];
    const result = (await handler.act(
      { toolCalls: calls },
      makeCtx(),
    )) as ToolActionResult;

    expect(result.toolActResult.toolCallsMade).toBe(true);
    expect(result.toolActResult.toolResults).toHaveLength(1);

    const entry = result.toolActResult.toolResults[0];
    expect(entry.toolCallId).toBe("call-1");
    expect(entry.toolName).toBe("test.echo");
    expect(entry.success).toBe(true);
    expect(entry.output).toEqual({ echoed: "hello" });
    expect(entry.error).toBeUndefined();
  });

  it("executes multiple toolCalls concurrently and preserves order", async () => {
    const pipeline = makePipeline([echoTool(), addTool(), upperTool()]);
    const handler = createToolActHandler(pipeline);
    const calls: ToolCall[] = [
      { id: "c-echo", name: "test.echo", arguments: { msg: "hi" } },
      { id: "c-add", name: "test.add", arguments: { a: 2, b: 3 } },
      { id: "c-up", name: "test.upper", arguments: { s: "abc" } },
    ];
    const result = (await handler.act(
      { toolCalls: calls },
      makeCtx(),
    )) as ToolActionResult;

    expect(result.toolActResult.toolCallsMade).toBe(true);
    expect(result.toolActResult.toolResults).toHaveLength(3);

    // executeBatch preserves input order
    const [r1, r2, r3] = result.toolActResult.toolResults;
    expect(r1.toolCallId).toBe("c-echo");
    expect(r1.success).toBe(true);
    expect(r1.output).toEqual({ echoed: "hi" });

    expect(r2.toolCallId).toBe("c-add");
    expect(r2.success).toBe(true);
    expect(r2.output).toEqual({ sum: 5 });

    expect(r3.toolCallId).toBe("c-up");
    expect(r3.success).toBe(true);
    expect(r3.output).toEqual({ out: "ABC" });
  });

  it("surfaces ToolNotFoundError as a structured (success: false) entry, not a throw", async () => {
    const pipeline = makePipeline(); // empty registry — nothing is registered
    const handler = createToolActHandler(pipeline);
    const calls: ToolCall[] = [
      { id: "call-x", name: "nonexistent.tool", arguments: {} },
    ];
    const result = (await handler.act(
      { toolCalls: calls },
      makeCtx(),
    )) as ToolActionResult;

    expect(result.toolActResult.toolCallsMade).toBe(true);
    expect(result.toolActResult.toolResults).toHaveLength(1);

    const entry = result.toolActResult.toolResults[0];
    expect(entry.success).toBe(false);
    expect(entry.error?.name).toBe("ToolNotFoundError");
    expect(entry.error?.code).toBe("TOOL_NOT_FOUND");
    expect(entry.error?.message).toContain("nonexistent.tool");
  });

  it("preserves the original decision (text + extra fields) in the result", async () => {
    const pipeline = makePipeline([echoTool()]);
    const handler = createToolActHandler(pipeline);
    const decision = {
      text: "running tool",
      done: false,
      toolCalls: [
        { id: "call-1", name: "test.echo", arguments: { msg: "x" } },
      ],
      // Extra free-form fields the LLM might emit should pass through verbatim.
      reasoning: "I need to call echo to verify the system works",
    };
    const result = (await handler.act(decision, makeCtx())) as ToolActionResult;

    expect(result.decision.text).toBe("running tool");
    expect(result.decision.done).toBe(false);
    expect(result.decision.reasoning).toBe(
      "I need to call echo to verify the system works",
    );
    expect(result.toolActResult.toolCallsMade).toBe(true);
    expect(result.toolActResult.toolResults).toHaveLength(1);
  });
});

describe("createToolActHandler — pipeline integration", () => {
  it("calls pipeline.executeBatch exactly once with the toolCalls array", async () => {
    const pipeline = makePipeline([echoTool()]);
    const spy = vi.spyOn(pipeline, "executeBatch");
    const handler = createToolActHandler(pipeline);
    const calls: ToolCall[] = [
      { id: "call-1", name: "test.echo", arguments: { msg: "a" } },
      { id: "call-2", name: "test.echo", arguments: { msg: "b" } },
    ];
    await handler.act({ toolCalls: calls }, makeCtx());

    expect(spy).toHaveBeenCalledTimes(1);
    // First positional arg is the toolCalls array (same length & content).
    const passedCalls = spy.mock.calls[0]?.[0] as readonly ToolCall[];
    expect(passedCalls).toHaveLength(2);
    expect(passedCalls[0]).toEqual(calls[0]);
    expect(passedCalls[1]).toEqual(calls[1]);
    spy.mockRestore();
  });

  it("does NOT call pipeline.executeBatch when there are no tool calls", async () => {
    const pipeline = makePipeline([echoTool()]);
    const spy = vi.spyOn(pipeline, "executeBatch");
    const handler = createToolActHandler(pipeline);
    await handler.act({ text: "just text, no calls" }, makeCtx());
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("forwards an AbortSignal from ExecutionContext to the pipeline", async () => {
    const pipeline = makePipeline([echoTool()]);
    const spy = vi.spyOn(pipeline, "executeBatch");
    const handler = createToolActHandler(pipeline);
    const ctx = makeCtx();
    await handler.act(
      {
        toolCalls: [
          { id: "call-1", name: "test.echo", arguments: { msg: "x" } },
        ],
      },
      ctx,
    );
    // Second positional arg is the ToolContext — verify signal was forwarded.
    const passedCtx = spy.mock.calls[0]?.[1] as { abortSignal?: AbortSignal };
    expect(passedCtx.abortSignal).toBe(ctx.signal);
    spy.mockRestore();
  });
});
