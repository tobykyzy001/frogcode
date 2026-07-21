import { describe, it, expect } from "vitest";
import type { ToolContext } from "../src/context.js";
import {
  complexInput,
  createMockPermissionEngine,
  createMockSandbox,
  createMockTool,
  nestedOutput,
  simpleBoolInput,
  simpleNumberInput,
  simpleStringInput,
  TEST_TOOL_IDS,
  TEST_TOOL_TAGS,
} from "../src/index.js";

const ctx = {} as ToolContext;

describe("createMockTool", () => {
  it("returns a ToolDefinition with default id and description", () => {
    const tool = createMockTool();
    expect(tool.id).toBe("mock.tool");
    expect(tool.description).toContain("mock");
    expect(typeof tool.execute).toBe("function");
    expect(tool.timeoutMs).toBe(60000);
    expect(tool.maxMemoryMB).toBe(512);
  });

  it("respects custom id", () => {
    const tool = createMockTool({ id: "test.custom" });
    expect(tool.id).toBe("test.custom");
  });

  it("execute returns the configured result", async () => {
    const tool = createMockTool({ result: { custom: true } });
    const output = await tool.execute({} as never, ctx);
    expect(output).toEqual({ custom: true });
  });

  it("execute rejects with the configured error", async () => {
    const tool = createMockTool({ error: new Error("boom") });
    await expect(tool.execute({} as never, ctx)).rejects.toThrow("boom");
  });

  it("execute waits for the configured delay", async () => {
    const tool = createMockTool({ delayMs: 50 });
    const start = Date.now();
    await tool.execute({} as never, ctx);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });
});

describe("createMockPermissionEngine", () => {
  it("returns allowed=true by default", async () => {
    const engine = createMockPermissionEngine();
    const tool = createMockTool({ id: "test.foo" });
    const decision = await engine.check(tool, {}, ctx);
    expect(decision.allowed).toBe(true);
  });

  it("returns the configured defaultDecision", async () => {
    const engine = createMockPermissionEngine({
      defaultDecision: { allowed: false, reason: "nope" },
    });
    const tool = createMockTool({ id: "test.foo" });
    const decision = await engine.check(tool, {}, ctx);
    expect(decision).toEqual({ allowed: false, reason: "nope" });
  });

  it("returns per-tool overrides", async () => {
    const engine = createMockPermissionEngine({
      decisionsByToolId: {
        "fs.read": { allowed: false, reason: "fs blocked" },
      },
    });
    const blocked = createMockTool({ id: "fs.read" });
    const allowed = createMockTool({ id: "test.other" });
    const blockedDecision = await engine.check(blocked, {}, ctx);
    const allowedDecision = await engine.check(allowed, {}, ctx);
    expect(blockedDecision).toEqual({ allowed: false, reason: "fs blocked" });
    expect(allowedDecision).toEqual({ allowed: true });
  });

  it("populates callsLog when provided", async () => {
    const callsLog: Array<{ toolId: string; input: unknown }> = [];
    const engine = createMockPermissionEngine({ callsLog });
    const tool = createMockTool({ id: "test.foo" });
    await engine.check(tool, { x: 1 }, ctx);
    await engine.check(tool, { x: 2 }, ctx);
    expect(callsLog).toHaveLength(2);
    expect(callsLog[0]).toEqual({ toolId: "test.foo", input: { x: 1 } });
    expect(callsLog[1]).toEqual({ toolId: "test.foo", input: { x: 2 } });
  });

  it("supports addRule / listRules / removeRule", () => {
    const engine = createMockPermissionEngine();
    engine.addRule({ toolId: "fs.read", decision: "allow" });
    engine.addRule({ toolId: "shell.exec", decision: "deny" });
    expect(engine.listRules()).toHaveLength(2);
    engine.removeRule(0);
    expect(engine.listRules()).toHaveLength(1);
    expect(engine.listRules()[0].toolId).toBe("shell.exec");
  });
});

describe("createMockSandbox", () => {
  it("returns success with default output", async () => {
    const sandbox = createMockSandbox();
    const result = await sandbox.run("any", {});
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ ok: true });
  });

  it("returns failure with timeout error when failWithTimeout is true", async () => {
    const sandbox = createMockSandbox({ failWithTimeout: true });
    const result = await sandbox.run("any", {});
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("ToolTimeoutError");
    expect(result.error?.timeoutMs).toBe(60000);
  });

  it("returns failure with crash error when failWithCrash is true", async () => {
    const sandbox = createMockSandbox({ failWithCrash: true });
    const result = await sandbox.run("any", {});
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("ToolCrashError");
    expect(result.error?.exitCode).toBe(1);
  });

  it("returns the configured defaultOutput", async () => {
    const sandbox = createMockSandbox({ defaultOutput: { custom: 42 } });
    const result = await sandbox.run("any", {});
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ custom: 42 });
  });
});

describe("fixtures", () => {
  it("simpleStringInput parses valid input", () => {
    const parsed = simpleStringInput.parse({ message: "hi" });
    expect(parsed.message).toBe("hi");
  });

  it("simpleNumberInput rejects non-positive numbers", () => {
    expect(() => simpleNumberInput.parse({ count: -1 })).toThrow();
    expect(() => simpleNumberInput.parse({ count: 1.5 })).toThrow();
  });

  it("simpleBoolInput parses boolean", () => {
    const parsed = simpleBoolInput.parse({ enabled: true });
    expect(parsed.enabled).toBe(true);
  });

  it("complexInput fills defaults for optional fields", () => {
    const parsed = complexInput.parse({ path: "/x" });
    expect(parsed.path).toBe("/x");
    expect(parsed.encoding).toBe("utf-8");
    expect(parsed.maxBytes).toBe(1024);
  });

  it("nestedOutput validates nested structure", () => {
    const valid = nestedOutput.parse({
      status: "ok",
      data: { items: [{ id: "1", value: "x" }], total: 1 },
    });
    expect(valid.status).toBe("ok");
    expect(valid.data.total).toBe(1);
  });

  it("TEST_TOOL_IDS exposes the expected ids", () => {
    expect(TEST_TOOL_IDS.simple).toBe("test.echo");
    expect(TEST_TOOL_IDS.fs).toBe("fs.read");
  });

  it("TEST_TOOL_TAGS exposes frozen-like arrays", () => {
    expect(TEST_TOOL_TAGS.readonly).toContain("readonly");
    expect(TEST_TOOL_TAGS.shell).toContain("subprocess");
  });
});
