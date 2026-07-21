import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import {
  ToolRegistry,
  ToolAlreadyRegisteredError,
  ToolNotFoundError,
  createTool,
  createMockTool,
  toLLMTool,
  type ToolDefinition,
} from "../src/index.js";

const makeTool = (id: string, tags: string[] = []): ToolDefinition =>
  createTool({
    id,
    description: `tool ${id}`,
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
    execute: async () => ({ ok: true }),
    tags,
  });

// Hand-build a ToolDefinition-like object so we can inject invalid fields that
// createTool() would itself reject. Cast through `unknown` to bypass the TS
// type guard — the registry's runtime checks are what we are testing.
const makeHandBuiltTool = (overrides: {
  id?: string;
  execute?: unknown;
}): ToolDefinition =>
  ({
    id: overrides.id ?? "test.echo",
    description: "test tool",
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
    execute:
      overrides.execute ??
      (async () => ({ ok: true }) as { ok: boolean }),
    timeoutMs: 60000,
    maxMemoryMB: 512,
    tags: [],
  }) as unknown as ToolDefinition;

describe("ToolRegistry.register", () => {
  let reg: ToolRegistry;
  beforeEach(() => {
    reg = new ToolRegistry();
  });

  it("adds a tool to the registry", () => {
    const tool = makeTool("test.echo");
    reg.register(tool);
    expect(reg.has("test.echo")).toBe(true);
    expect(reg.size).toBe(1);
  });

  it("returns undefined (void) on success", () => {
    const result = reg.register(makeTool("test.echo"));
    expect(result).toBeUndefined();
  });

  it("throws ToolAlreadyRegisteredError on duplicate id", () => {
    reg.register(makeTool("test.echo"));
    expect(() => reg.register(makeTool("test.echo"))).toThrow(
      ToolAlreadyRegisteredError,
    );
    expect(() => reg.register(makeTool("test.echo"))).toThrow(/test\.echo/);
  });

  it("duplicate error exposes .toolId and .name properties", () => {
    reg.register(makeTool("test.echo"));
    let caught: ToolAlreadyRegisteredError | undefined;
    try {
      reg.register(makeTool("test.echo"));
    } catch (e) {
      caught = e as ToolAlreadyRegisteredError;
    }
    expect(caught).toBeInstanceOf(ToolAlreadyRegisteredError);
    expect(caught?.name).toBe("ToolAlreadyRegisteredError");
    expect(caught?.toolId).toBe("test.echo");
    expect(caught?.message).toContain("test.echo");
  });

  it("rejects non-function execute with descriptive error", () => {
    const bad = makeHandBuiltTool({ execute: "not a function" });
    expect(() => reg.register(bad)).toThrow(/execute must be a function/);
  });

  it("rejects empty id with descriptive error", () => {
    const bad = makeHandBuiltTool({ id: "" });
    expect(() => reg.register(bad)).toThrow(/non-empty string/);
  });
});

describe("ToolRegistry.unregister", () => {
  let reg: ToolRegistry;
  beforeEach(() => {
    reg = new ToolRegistry();
  });

  it("returns true when unregistering an existing tool", () => {
    reg.register(makeTool("test.echo"));
    expect(reg.unregister("test.echo")).toBe(true);
    expect(reg.has("test.echo")).toBe(false);
    expect(reg.size).toBe(0);
  });

  it("returns false when unregistering a non-existing tool", () => {
    expect(reg.unregister("missing.tool")).toBe(false);
  });
});

describe("ToolRegistry.get", () => {
  let reg: ToolRegistry;
  beforeEach(() => {
    reg = new ToolRegistry();
  });

  it("returns the tool definition for an existing id", () => {
    const tool = makeTool("test.echo");
    reg.register(tool);
    expect(reg.get("test.echo")).toBe(tool);
  });

  it("returns undefined for a non-existing id", () => {
    expect(reg.get("missing.tool")).toBeUndefined();
  });
});

describe("ToolRegistry.has", () => {
  let reg: ToolRegistry;
  beforeEach(() => {
    reg = new ToolRegistry();
  });

  it("returns true for existing id and false for non-existing", () => {
    reg.register(makeTool("test.echo"));
    expect(reg.has("test.echo")).toBe(true);
    expect(reg.has("missing.tool")).toBe(false);
  });
});

describe("ToolRegistry.list", () => {
  let reg: ToolRegistry;
  beforeEach(() => {
    reg = new ToolRegistry();
  });

  it("returns all registered tools in insertion order", () => {
    const t1 = makeTool("test.a");
    const t2 = makeTool("test.b");
    const t3 = makeTool("test.c");
    reg.register(t1);
    reg.register(t2);
    reg.register(t3);
    const all = reg.list();
    expect(all).toHaveLength(3);
    expect(all.map((t) => t.id)).toEqual(["test.a", "test.b", "test.c"]);
    // Same reference (registry stores ref, no copy)
    expect(all[0]).toBe(t1);
    expect(all[2]).toBe(t3);
  });

  it("returns an empty array when registry is empty", () => {
    expect(reg.list()).toEqual([]);
  });
});

describe("ToolRegistry.listByTag", () => {
  let reg: ToolRegistry;
  beforeEach(() => {
    reg = new ToolRegistry();
  });

  it("filters tools by tag preserving insertion order", () => {
    const t1 = makeTool("test.a", ["readonly", "safe"]);
    const t2 = makeTool("test.b", ["write", "destructive"]);
    const t3 = makeTool("test.c", ["network"]);
    reg.register(t1);
    reg.register(t2);
    reg.register(t3);

    expect(reg.listByTag("readonly").map((t) => t.id)).toEqual(["test.a"]);
    expect(reg.listByTag("safe").map((t) => t.id)).toEqual(["test.a"]);
    expect(reg.listByTag("network").map((t) => t.id)).toEqual(["test.c"]);
    expect(reg.listByTag("write").map((t) => t.id)).toEqual(["test.b"]);

    // Multi-match preserves order
    const allSafe = reg.listByTag("safe");
    expect(allSafe).toHaveLength(1);

    // Non-existent tag returns empty
    expect(reg.listByTag("nonexistent")).toEqual([]);
  });
});

describe("ToolRegistry.toLLMTools", () => {
  let reg: ToolRegistry;
  beforeEach(() => {
    reg = new ToolRegistry();
  });

  it("returns LLMToolDefinition[] for all registered tools when no filter", () => {
    reg.register(makeTool("test.a"));
    reg.register(makeTool("test.b"));
    reg.register(makeTool("test.c"));
    const tools = reg.toLLMTools();
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.function.name)).toEqual([
      "test.a",
      "test.b",
      "test.c",
    ]);
    for (const t of tools) {
      expect(t.type).toBe("function");
      expect(t.function.description).toContain("tool test.");
      expect(t.function.parameters).toBeTypeOf("object");
    }
  });

  it("returns only tools whose id appears in the filter", () => {
    reg.register(makeTool("test.a"));
    reg.register(makeTool("test.b"));
    reg.register(makeTool("test.c"));
    const filtered = reg.toLLMTools(["test.a", "test.c"]);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((t) => t.function.name)).toEqual([
      "test.a",
      "test.c",
    ]);
  });

  it("returns empty array when filter matches nothing (no error)", () => {
    reg.register(makeTool("test.a"));
    expect(reg.toLLMTools(["nonexistent.tool"])).toEqual([]);
  });

  it("returns empty array when registry is empty and no filter", () => {
    expect(reg.toLLMTools()).toEqual([]);
  });

  it("produces shapes equivalent to toLLMTool() applied per tool", () => {
    const t1 = makeTool("test.a");
    const t2 = makeTool("test.b");
    reg.register(t1);
    reg.register(t2);
    const expected = [toLLMTool(t1), toLLMTool(t2)];
    expect(reg.toLLMTools()).toEqual(expected);
  });
});

describe("ToolRegistry.clear and size", () => {
  let reg: ToolRegistry;
  beforeEach(() => {
    reg = new ToolRegistry();
  });

  it("clear empties the registry", () => {
    reg.register(makeTool("test.a"));
    reg.register(makeTool("test.b"));
    expect(reg.size).toBe(2);
    reg.clear();
    expect(reg.size).toBe(0);
    expect(reg.list()).toEqual([]);
    expect(reg.has("test.a")).toBe(false);
  });

  it("size getter reflects register/unregister/clear operations", () => {
    expect(reg.size).toBe(0);
    reg.register(makeTool("test.a"));
    expect(reg.size).toBe(1);
    reg.register(makeTool("test.b"));
    expect(reg.size).toBe(2);
    reg.unregister("test.a");
    expect(reg.size).toBe(1);
    reg.clear();
    expect(reg.size).toBe(0);
  });
});

describe("Error classes (constructibility)", () => {
  it("ToolAlreadyRegisteredError is an Error with name + toolId", () => {
    const err = new ToolAlreadyRegisteredError("dup.tool");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ToolAlreadyRegisteredError);
    expect(err.name).toBe("ToolAlreadyRegisteredError");
    expect(err.toolId).toBe("dup.tool");
    expect(err.message).toContain("dup.tool");
    expect(err.message).toContain("already registered");
  });

  it("ToolNotFoundError is an Error with name + toolId", () => {
    const err = new ToolNotFoundError("missing.tool");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ToolNotFoundError);
    expect(err.name).toBe("ToolNotFoundError");
    expect(err.toolId).toBe("missing.tool");
    expect(err.message).toContain("missing.tool");
    expect(err.message).toContain("not found");
  });
});

describe("ToolRegistry interop with createMockTool", () => {
  it("registers mock tools and converts them to LLM tools", () => {
    const reg = new ToolRegistry();
    const t1 = createMockTool({ id: "mock.a", tags: ["readonly"] });
    const t2 = createMockTool({ id: "mock.b", tags: ["network"] });
    reg.register(t1);
    reg.register(t2);

    expect(reg.size).toBe(2);
    expect(reg.listByTag("readonly").map((t) => t.id)).toEqual(["mock.a"]);

    const llm = reg.toLLMTools(["mock.b"]);
    expect(llm).toHaveLength(1);
    expect(llm[0].function.name).toBe("mock.b");
  });
});
