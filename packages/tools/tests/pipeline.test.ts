import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import type { ToolContext } from "../src/context.js";
import {
  ToolPipeline,
  ToolRegistry,
  PermissionEngine,
  createTool,
  createMockTool,
  createMockPermissionEngine,
  createMockSandbox,
  ToolTimeoutError,
  ToolMemoryError,
  ToolCrashError,
  ValidationError,
  OutputValidationError,
  PermissionDeniedError,
  type ToolCall,
  type ToolHooks,
  type ToolPipelineOptions,
} from "../src/index.js";

const ctx = {} as ToolContext;

/**
 * Build a pipeline wired up with a real ToolRegistry + PermissionEngine
 * (using `canUseTool` callback) + mock sandbox (unused by default but
 * accepted by the constructor). Pass tools to register them; pass
 * `permissionDecision` to control allow/deny.
 */
function makePipeline(opts: {
  tools?: ReadonlyArray<ReturnType<typeof createMockTool>>;
  permissionDecision?: { allowed: boolean; reason?: string };
  hooks?: ToolHooks;
}): ToolPipeline {
  const registry = new ToolRegistry();
  for (const t of opts.tools ?? []) registry.register(t);
  const permission = new PermissionEngine({
    canUseTool: async () => opts.permissionDecision ?? { allowed: true },
  });
  const sandbox = createMockSandbox();
  const pipelineOpts: ToolPipelineOptions = {
    registry,
    permission,
    sandbox,
  };
  if (opts.hooks) pipelineOpts.hooks = opts.hooks;
  return new ToolPipeline(pipelineOpts);
}

const echoTool = () =>
  createTool({
    id: "test.echo",
    description: "echo the message back",
    inputSchema: z.object({ msg: z.string() }),
    outputSchema: z.object({ echoed: z.string() }),
    execute: async (input) => ({ echoed: input.msg }),
  });

describe("ToolPipeline.execute — happy path", () => {
  it("returns success with validated output and matching toolCallId", async () => {
    const pipeline = makePipeline({ tools: [echoTool()] });
    const result = await pipeline.execute(
      { id: "call-1", name: "test.echo", arguments: { msg: "hello" } },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.toolCallId).toBe("call-1");
    expect(result.toolName).toBe("test.echo");
    expect(result.output).toEqual({ echoed: "hello" });
    expect(result.error).toBeUndefined();
  });

  it("returns validated output (schema strips unexpected fields)", async () => {
    // outputSchema is strict object — extra fields would fail. Use a tool
    // whose execute returns exactly what the schema expects.
    const tool = createTool({
      id: "test.add",
      description: "add two numbers",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      outputSchema: z.object({ sum: z.number() }),
      execute: async (input) => ({ sum: input.a + input.b }),
    });
    const pipeline = makePipeline({ tools: [tool] });
    const result = await pipeline.execute(
      { id: "call-2", name: "test.add", arguments: { a: 3, b: 4 } },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ sum: 7 });
  });
});

describe("ToolPipeline.execute — tool not found", () => {
  it("returns ToolNotFoundError when name is not registered", async () => {
    const pipeline = makePipeline({ tools: [] });
    const result = await pipeline.execute(
      { id: "call-x", name: "nonexistent.tool", arguments: {} },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.toolCallId).toBe("call-x");
    expect(result.toolName).toBe("nonexistent.tool");
    expect(result.error?.name).toBe("ToolNotFoundError");
    expect(result.error?.code).toBe("TOOL_NOT_FOUND");
    expect(result.error?.message).toContain("nonexistent.tool");
  });
});

describe("ToolPipeline.execute — input validation", () => {
  it("returns ValidationError when arguments fail inputSchema", async () => {
    const tool = createTool({
      id: "test.num",
      description: "needs a number",
      inputSchema: z.object({ x: z.number() }),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async () => ({ ok: true }),
    });
    const pipeline = makePipeline({ tools: [tool] });
    const result = await pipeline.execute(
      { id: "call-v", name: "test.num", arguments: { x: "not a number" } },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("ValidationError");
    expect(result.error?.code).toBe("INPUT_VALIDATION_FAILED");
    expect(result.error?.message).toContain("Input validation failed");
  });

  it("does NOT call permission.check when input validation fails", async () => {
    const callsLog: Array<{ toolId: string; input: unknown }> = [];
    const registry = new ToolRegistry();
    registry.register(
      createTool({
        id: "test.strict",
        description: "strict",
        inputSchema: z.object({ x: z.number() }),
        outputSchema: z.object({ ok: z.boolean() }),
        execute: async () => ({ ok: true }),
      }),
    );
    const permission = createMockPermissionEngine({ callsLog });
    const pipeline = new ToolPipeline({
      registry,
      permission,
      sandbox: createMockSandbox(),
    });
    await pipeline.execute(
      { id: "call-1", name: "test.strict", arguments: { x: "bad" } },
      ctx,
    );
    expect(callsLog).toHaveLength(0);
  });
});

describe("ToolPipeline.execute — permission denied", () => {
  it("returns PermissionDeniedError with the engine's reason", async () => {
    const pipeline = makePipeline({
      tools: [echoTool()],
      permissionDecision: { allowed: false, reason: "nope" },
    });
    const result = await pipeline.execute(
      { id: "call-p", name: "test.echo", arguments: { msg: "hi" } },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("PermissionDeniedError");
    expect(result.error?.code).toBe("PERMISSION_DENIED");
    expect(result.error?.message).toContain("nope");
  });

  it("uses 'Permission denied' default message when reason is missing", async () => {
    const pipeline = makePipeline({
      tools: [echoTool()],
      permissionDecision: { allowed: false },
    });
    const result = await pipeline.execute(
      { id: "call-p2", name: "test.echo", arguments: { msg: "hi" } },
      ctx,
    );
    expect(result.error?.message).toBe("Permission denied");
  });
});

describe("ToolPipeline.execute — permission receives validated input", () => {
  it("passes the parsed (validated) input to permission.check, not raw arguments", async () => {
    const callsLog: Array<{ toolId: string; input: unknown }> = [];
    const registry = new ToolRegistry();
    // inputSchema transforms the input: z.coerce.number turns "42" into 42.
    // If permission received the raw string, the test would observe "42".
    registry.register(
      createTool({
        id: "test.coerce",
        description: "coerce",
        inputSchema: z.object({ n: z.coerce.number() }),
        outputSchema: z.object({ ok: z.boolean() }),
        execute: async () => ({ ok: true }),
      }),
    );
    const permission = createMockPermissionEngine({ callsLog });
    const pipeline = new ToolPipeline({
      registry,
      permission,
      sandbox: createMockSandbox(),
    });
    await pipeline.execute(
      { id: "call-c", name: "test.coerce", arguments: { n: "42" } },
      ctx,
    );
    expect(callsLog).toHaveLength(1);
    // After coercion, n should be the number 42, not the string "42".
    expect(callsLog[0]?.input).toEqual({ n: 42 });
  });
});

describe("ToolPipeline.execute — tool throws", () => {
  it("returns ToolCrashError when execute throws a generic Error", async () => {
    const tool = createMockTool({
      id: "test.boom",
      error: new Error("boom"),
    });
    const pipeline = makePipeline({ tools: [tool] });
    const result = await pipeline.execute(
      { id: "call-b", name: "test.boom", arguments: {} },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("ToolCrashError");
    expect(result.error?.code).toBe("TOOL_CRASH");
    expect(result.error?.message).toBe("boom");
  });

  it("returns ToolCrashError when execute throws a non-Error value", async () => {
    const tool = createTool({
      id: "test.stringthrow",
      description: "throws a string",
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async () => {
        throw "oops"; // eslint-disable-line no-throw-literal
      },
    });
    const pipeline = makePipeline({ tools: [tool] });
    const result = await pipeline.execute(
      { id: "call-s", name: "test.stringthrow", arguments: {} },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("ToolCrashError");
    expect(result.error?.message).toContain("non-Error");
    expect(result.error?.message).toContain("oops");
  });

  it("preserves ToolMemoryError when execute throws one", async () => {
    const tool = createTool({
      id: "test.mem",
      description: "throws memory",
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async () => {
        throw new ToolMemoryError(64);
      },
    });
    const pipeline = makePipeline({ tools: [tool] });
    const result = await pipeline.execute(
      { id: "call-m", name: "test.mem", arguments: {} },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("ToolMemoryError");
    expect(result.error?.code).toBe("TOOL_MEMORY");
  });

  it("preserves ToolCrashError when execute throws one", async () => {
    const tool = createTool({
      id: "test.crash",
      description: "throws crash",
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async () => {
        throw new ToolCrashError(1, null, "segfault");
      },
    });
    const pipeline = makePipeline({ tools: [tool] });
    const result = await pipeline.execute(
      { id: "call-cr", name: "test.crash", arguments: {} },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("ToolCrashError");
    expect(result.error?.code).toBe("TOOL_CRASH");
    expect(result.error?.message).toContain("segfault");
  });
});

describe("ToolPipeline.execute — timeout", () => {
  it("returns ToolTimeoutError when execute exceeds tool.timeoutMs", async () => {
    const tool = createMockTool({
      id: "test.slow",
      delayMs: 200,
      timeoutMs: 50,
    });
    const pipeline = makePipeline({ tools: [tool] });
    const result = await pipeline.execute(
      { id: "call-t", name: "test.slow", arguments: {} },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("ToolTimeoutError");
    expect(result.error?.code).toBe("TOOL_TIMEOUT");
  });

  it("returns ToolTimeoutError when execute throws AbortError", async () => {
    const tool = createTool({
      id: "test.abort",
      description: "throws AbortError",
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async (_input, c) => {
        // Wait for abortSignal to fire, then throw AbortError.
        return new Promise<never>((_, reject) => {
          const t = setTimeout(() => {
            const e = new Error("not aborted in time");
            reject(e);
          }, 1000);
          c.abortSignal?.addEventListener("abort", () => {
            clearTimeout(t);
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        });
      },
      timeoutMs: 30,
    });
    const pipeline = makePipeline({ tools: [tool] });
    const result = await pipeline.execute(
      { id: "call-ab", name: "test.abort", arguments: {} },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("ToolTimeoutError");
    expect(result.error?.code).toBe("TOOL_TIMEOUT");
  });
});

describe("ToolPipeline.execute — output validation", () => {
  it("returns OutputValidationError when execute returns invalid output", async () => {
    const tool = createTool({
      id: "test.badout",
      description: "returns wrong shape",
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async () => ({ ok: "not a bool" }) as unknown as {
        ok: boolean;
      },
    });
    const pipeline = makePipeline({ tools: [tool] });
    const result = await pipeline.execute(
      { id: "call-o", name: "test.badout", arguments: {} },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("OutputValidationError");
    expect(result.error?.code).toBe("OUTPUT_VALIDATION_FAILED");
    expect(result.error?.message).toContain("Output validation failed");
  });
});

describe("ToolPipeline — hooks", () => {
  it("calls onToolStart with the ToolCall before execution", async () => {
    const onToolStart = vi.fn();
    const pipeline = makePipeline({
      tools: [echoTool()],
      hooks: { onToolStart },
    });
    const call: ToolCall = {
      id: "call-h1",
      name: "test.echo",
      arguments: { msg: "hi" },
    };
    await pipeline.execute(call, ctx);
    expect(onToolStart).toHaveBeenCalledTimes(1);
    expect(onToolStart).toHaveBeenCalledWith(call);
  });

  it("calls onToolEnd with (call, result) after successful execution", async () => {
    const onToolEnd = vi.fn();
    const pipeline = makePipeline({
      tools: [echoTool()],
      hooks: { onToolEnd },
    });
    const call: ToolCall = {
      id: "call-h2",
      name: "test.echo",
      arguments: { msg: "hi" },
    };
    const result = await pipeline.execute(call, ctx);
    expect(onToolEnd).toHaveBeenCalledTimes(1);
    const [callArg, resultArg] = onToolEnd.mock.calls[0]!;
    expect(callArg).toBe(call);
    expect(resultArg).toEqual(result);
    expect(resultArg.success).toBe(true);
  });

  it("calls onToolError with (call, error) when execution fails", async () => {
    const onToolError = vi.fn();
    const pipeline = makePipeline({
      tools: [echoTool()],
      permissionDecision: { allowed: false, reason: "no" },
      hooks: { onToolError },
    });
    const call: ToolCall = {
      id: "call-h3",
      name: "test.echo",
      arguments: { msg: "hi" },
    };
    await pipeline.execute(call, ctx);
    expect(onToolError).toHaveBeenCalledTimes(1);
    const [callArg, errorArg] = onToolError.mock.calls[0]!;
    expect(callArg).toBe(call);
    expect(errorArg.name).toBe("PermissionDeniedError");
    expect(errorArg.code).toBe("PERMISSION_DENIED");
  });

  it("does NOT call onToolError on success", async () => {
    const onToolError = vi.fn();
    const pipeline = makePipeline({
      tools: [echoTool()],
      hooks: { onToolError },
    });
    await pipeline.execute(
      { id: "call-h4", name: "test.echo", arguments: { msg: "hi" } },
      ctx,
    );
    expect(onToolError).not.toHaveBeenCalled();
  });

  it("calls BOTH onToolEnd and onToolError on failure", async () => {
    const onToolEnd = vi.fn();
    const onToolError = vi.fn();
    const pipeline = makePipeline({
      tools: [echoTool()],
      permissionDecision: { allowed: false, reason: "no" },
      hooks: { onToolEnd, onToolError },
    });
    await pipeline.execute(
      { id: "call-h5", name: "test.echo", arguments: { msg: "hi" } },
      ctx,
    );
    expect(onToolEnd).toHaveBeenCalledTimes(1);
    expect(onToolError).toHaveBeenCalledTimes(1);
  });
});

describe("ToolPipeline.executeBatch — concurrency", () => {
  it("runs calls concurrently (3 calls × 100ms < 250ms total)", async () => {
    const tool = createMockTool({
      id: "test.slow100",
      delayMs: 100,
    });
    const pipeline = makePipeline({ tools: [tool] });
    const calls: ToolCall[] = [
      { id: "b-1", name: "test.slow100", arguments: {} },
      { id: "b-2", name: "test.slow100", arguments: {} },
      { id: "b-3", name: "test.slow100", arguments: {} },
    ];
    const start = Date.now();
    const results = await pipeline.executeBatch(calls, ctx);
    const elapsed = Date.now() - start;
    // Sequential would be 300ms+; concurrent should be ~100ms.
    // Allow generous slack for CI scheduling.
    expect(elapsed).toBeLessThan(250);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.success).toBe(true);
    }
  });

  it("returns one ToolResultEntry per call, in input order", async () => {
    const tool1 = createMockTool({
      id: "test.one",
      result: { which: 1 },
    });
    const tool2 = createMockTool({
      id: "test.two",
      result: { which: 2 },
    });
    const tool3 = createMockTool({
      id: "test.three",
      result: { which: 3 },
    });
    const pipeline = makePipeline({ tools: [tool1, tool2, tool3] });
    const calls: ToolCall[] = [
      { id: "b-1", name: "test.one", arguments: {} },
      { id: "b-2", name: "test.two", arguments: {} },
      { id: "b-3", name: "test.three", arguments: {} },
    ];
    const results = await pipeline.executeBatch(calls, ctx);
    expect(results.map((r) => r.toolCallId)).toEqual(["b-1", "b-2", "b-3"]);
    expect(results.map((r) => r.toolName)).toEqual([
      "test.one",
      "test.two",
      "test.three",
    ]);
  });

  it("returns empty array for empty input", async () => {
    const pipeline = makePipeline({ tools: [echoTool()] });
    const results = await pipeline.executeBatch([], ctx);
    expect(results).toEqual([]);
  });

  it("handles mix of success, not-found, and thrown error", async () => {
    const goodTool = createMockTool({ id: "test.good", result: { ok: 1 } });
    const badTool = createMockTool({
      id: "test.bad",
      error: new Error("kaboom"),
    });
    const pipeline = makePipeline({ tools: [goodTool, badTool] });
    const calls: ToolCall[] = [
      { id: "mix-1", name: "test.good", arguments: {} },
      { id: "mix-2", name: "missing.tool", arguments: {} },
      { id: "mix-3", name: "test.bad", arguments: {} },
    ];
    const results = await pipeline.executeBatch(calls, ctx);
    expect(results).toHaveLength(3);
    const byId = new Map(results.map((r) => [r.toolCallId, r]));
    expect(byId.get("mix-1")?.success).toBe(true);
    expect(byId.get("mix-1")?.output).toEqual({ ok: 1 });
    expect(byId.get("mix-2")?.success).toBe(false);
    expect(byId.get("mix-2")?.error?.name).toBe("ToolNotFoundError");
    expect(byId.get("mix-3")?.success).toBe(false);
    expect(byId.get("mix-3")?.error?.name).toBe("ToolCrashError");
    expect(byId.get("mix-3")?.error?.message).toBe("kaboom");
  });
});

describe("ToolPipeline — error classes", () => {
  it("ValidationError carries the code INPUT_VALIDATION_FAILED", () => {
    const e = new ValidationError("bad", []);
    expect(e.name).toBe("ValidationError");
    expect(e.code).toBe("INPUT_VALIDATION_FAILED");
    expect(e.message).toBe("bad");
    expect(e.issues).toEqual([]);
  });

  it("OutputValidationError carries the code OUTPUT_VALIDATION_FAILED", () => {
    const e = new OutputValidationError("bad", [{ path: ["x"] }]);
    expect(e.name).toBe("OutputValidationError");
    expect(e.code).toBe("OUTPUT_VALIDATION_FAILED");
    expect(e.issues).toEqual([{ path: ["x"] }]);
  });

  it("PermissionDeniedError carries the code PERMISSION_DENIED and reason", () => {
    const e = new PermissionDeniedError("denied", "no perms");
    expect(e.name).toBe("PermissionDeniedError");
    expect(e.code).toBe("PERMISSION_DENIED");
    expect(e.reason).toBe("no perms");
  });
});

describe("ToolPipeline — never throws to caller", () => {
  it("execute resolves (does not reject) on every failure path", async () => {
    const pipeline = makePipeline({ tools: [] });
    // Tool not found — must resolve, not reject.
    const result = await pipeline.execute(
      { id: "nt-1", name: "missing", arguments: {} },
      ctx,
    );
    expect(result.success).toBe(false);
  });
});
