import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  createTool,
  toLLMTool,
  zodToJsonSchema,
  type ToolDefinition,
  type LLMToolDefinition,
} from "../src/index.js";

const echoToolDef = {
  id: "test.echo",
  description: "Echoes the input",
  inputSchema: z.object({ message: z.string() }),
  outputSchema: z.object({ echoed: z.string() }),
  execute: async (input: { message: string }) => ({ echoed: input.message }),
};

describe("createTool", () => {
  it("applies defaults and returns a frozen object", () => {
    const tool = createTool(echoToolDef);
    expect(tool.timeoutMs).toBe(60000);
    expect(tool.maxMemoryMB).toBe(512);
    expect(tool.tags).toEqual([]);
    expect(Object.isFrozen(tool)).toBe(true);
  });

  it("preserves custom timeoutMs, maxMemoryMB, and tags", () => {
    const tool = createTool({
      ...echoToolDef,
      timeoutMs: 30000,
      maxMemoryMB: 1024,
      tags: ["test", "echo"],
    });
    expect(tool.timeoutMs).toBe(30000);
    expect(tool.maxMemoryMB).toBe(1024);
    expect(tool.tags).toEqual(["test", "echo"]);
  });

  it("rejects id 'invalid_id' (underscore not allowed)", () => {
    expect(() => createTool({ ...echoToolDef, id: "invalid_id" })).toThrow(/id must be in format/);
  });

  it("rejects id 'valid' (no dot separator)", () => {
    expect(() => createTool({ ...echoToolDef, id: "valid" })).toThrow(/id must be in format/);
  });

  it("rejects empty description", () => {
    expect(() => createTool({ ...echoToolDef, description: "" })).toThrow(/non-empty description/);
    expect(() => createTool({ ...echoToolDef, description: "   " })).toThrow(/non-empty description/);
  });

  it("rejects non-Zod inputSchema", () => {
    expect(() =>
      createTool({
        ...echoToolDef,
        inputSchema: { fake: true } as unknown as z.ZodType<{ message: string }>,
      }),
    ).toThrow(/must be a Zod schema/);
  });

  it("rejects non-function execute", () => {
    expect(() =>
      createTool({
        ...echoToolDef,
        execute: "not a function" as unknown as (input: { message: string }) => Promise<{ echoed: string }>,
      }),
    ).toThrow(/execute must be a function/);
  });

  it("freezes the tags array", () => {
    const tool = createTool({ ...echoToolDef, tags: ["a", "b"] });
    expect(Object.isFrozen(tool.tags)).toBe(true);
  });

  it("does not mutate the tags input array", () => {
    const originalTags = ["a", "b"];
    createTool({ ...echoToolDef, tags: originalTags });
    expect(originalTags).toEqual(["a", "b"]);
  });
});

describe("toLLMTool", () => {
  it("produces the OpenAI function-call shape", () => {
    const tool = createTool(echoToolDef);
    const llm = toLLMTool(tool);
    expect(llm).toEqual({
      type: "function",
      function: {
        name: "test.echo",
        description: "Echoes the input\n\nTimeout: 60s",
        parameters: {
          type: "object",
          properties: {
            message: { type: "string" },
          },
          required: ["message"],
        },
      },
    });
  });

  it("does not leak execute/permission/timeoutMs/maxMemoryMB to the LLM", () => {
    const tool = createTool({
      ...echoToolDef,
      permission: { toolId: "test.echo", decision: "allow" },
    });
    const llm = toLLMTool(tool);
    const fn = llm.function as Record<string, unknown>;
    expect(fn.execute).toBeUndefined();
    expect(fn.permission).toBeUndefined();
    expect(fn.timeoutMs).toBeUndefined();
    expect(fn.maxMemoryMB).toBeUndefined();
    expect(fn.tags).toBeUndefined();
    expect(Object.keys(fn)).toEqual(["name", "description", "parameters"]);
  });

  it("appends 'Timeout: 60s' for the default 60000ms", () => {
    const tool = createTool(echoToolDef);
    const llm = toLLMTool(tool);
    expect(llm.function.description).toBe("Echoes the input\n\nTimeout: 60s");
  });

  it("appends 'Timeout: 30s' for timeoutMs=30000", () => {
    const tool = createTool({ ...echoToolDef, timeoutMs: 30000 });
    const llm = toLLMTool(tool);
    expect(llm.function.description).toBe("Echoes the input\n\nTimeout: 30s");
  });

  it("rounds up partial seconds (e.g. 30500ms -> 31s)", () => {
    const tool = createTool({ ...echoToolDef, timeoutMs: 30500 });
    const llm = toLLMTool(tool);
    expect(llm.function.description).toBe("Echoes the input\n\nTimeout: 31s");
  });
});

describe("zodToJsonSchema", () => {
  it("converts a simple object schema", () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name", "age"],
    });
  });

  it("does NOT include optional fields in required array", () => {
    const schema = z.object({
      name: z.string(),
      nickname: z.string().optional(),
    });
    const json = zodToJsonSchema(schema) as { required?: string[] };
    expect(json.required).toEqual(["name"]);
    expect(json.required).not.toContain("nickname");
  });

  it("does NOT include default-valued fields in required array", () => {
    const schema = z.object({
      name: z.string(),
      level: z.number().default(1),
    });
    const json = zodToJsonSchema(schema) as { required?: string[] };
    expect(json.required).toEqual(["name"]);
  });

  it("converts ZodEnum to { type: 'string', enum: [...] }", () => {
    const schema = z.object({
      color: z.enum(["red", "green", "blue"]),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: "object",
      properties: {
        color: { type: "string", enum: ["red", "green", "blue"] },
      },
      required: ["color"],
    });
  });

  it("converts number().int() to { type: 'integer' }", () => {
    const schema = z.object({
      count: z.number().int(),
      ratio: z.number(),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: "object",
      properties: {
        count: { type: "integer" },
        ratio: { type: "number" },
      },
      required: ["count", "ratio"],
    });
  });

  it("attaches description from .describe()", () => {
    const schema = z.object({
      email: z.string().email().describe("User email address"),
    });
    const json = zodToJsonSchema(schema) as {
      properties: Record<string, { description?: string }>;
    };
    expect(json.properties.email.description).toBe("User email address");
  });

  it("translates string().email() to format 'email'", () => {
    const json = zodToJsonSchema(z.string().email()) as { format?: string };
    expect(json.format).toBe("email");
  });

  it("translates string().url() to format 'uri'", () => {
    const json = zodToJsonSchema(z.string().url()) as { format?: string };
    expect(json.format).toBe("uri");
  });

  it("translates string min/max to minLength/maxLength", () => {
    const json = zodToJsonSchema(z.string().min(2).max(50)) as {
      minLength?: number;
      maxLength?: number;
    };
    expect(json.minLength).toBe(2);
    expect(json.maxLength).toBe(50);
  });

  it("translates number min/max to minimum/maximum", () => {
    const json = zodToJsonSchema(z.number().min(0).max(100)) as {
      minimum?: number;
      maximum?: number;
    };
    expect(json.minimum).toBe(0);
    expect(json.maximum).toBe(100);
  });

  it("converts ZodArray to { type: 'array', items: ... }", () => {
    const json = zodToJsonSchema(z.array(z.string()));
    expect(json).toEqual({ type: "array", items: { type: "string" } });
  });

  it("converts ZodRecord to { type: 'object', additionalProperties: ... }", () => {
    const json = zodToJsonSchema(z.record(z.number()));
    expect(json).toEqual({ type: "object", additionalProperties: { type: "number" } });
  });

  it("unwraps ZodEffects by skipping refine/transform", () => {
    const schema = z.object({
      name: z.string().refine((s) => s.length > 0).transform((s) => s.trim()),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
  });

  it("throws on unsupported Zod types", () => {
    const schema = z.literal("hello");
    expect(() => zodToJsonSchema(schema)).toThrow(/Unsupported Zod type/);
  });
});

describe("integration: createTool + toLLMTool shape", () => {
  it("produces a LLMToolDefinition with the correct runtime type", () => {
    const tool: ToolDefinition<{ x: number }, { y: number }> = createTool({
      id: "math.double",
      description: "Doubles a number",
      inputSchema: z.object({ x: z.number() }),
      outputSchema: z.object({ y: z.number() }),
      execute: async (input) => ({ y: input.x * 2 }),
    });
    const llm: LLMToolDefinition = toLLMTool(tool);
    expect(llm.type).toBe("function");
    expect(llm.function.name).toBe("math.double");
  });
});
