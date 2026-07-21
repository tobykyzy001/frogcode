import type { z } from "zod";
import type { ToolContext } from "./context.js";
import type { PermissionRule } from "./permission/rule.js";
import { zodToJsonSchema } from "./zod-to-json-schema.js";

export interface ToolDefinition<I = unknown, O = unknown> {
  readonly id: string;
  readonly description: string;
  // Use `z.ZodType<I, any, any>` (not `z.ZodType<I>`) so schemas with
  // `.default()` / `.transform()` are accepted — those have a different
  // `_input` type (pre-parse, fields optional) than `_output` (post-parse,
  // fields required). `I` stays the OUTPUT type, which is what `execute`
  // receives. The third type param (Input) is loosened to `any` so any
  // schema with `_output: I` satisfies the constraint.
  // biome-ignore lint/suspicious/noExplicitAny: Zod's _def and _input type params must be `any` to accept schemas with .default()/.transform() (input type differs from output type); I remains the output type used by execute()
  readonly inputSchema: z.ZodType<I, any, any>;
  readonly outputSchema: z.ZodType<O>;
  readonly execute: (input: I, ctx: ToolContext) => Promise<O>;
  readonly permission?: PermissionRule;
  readonly timeoutMs: number;
  readonly maxMemoryMB: number;
  readonly tags: readonly string[];
}

export interface LLMToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

const ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

function isZodSchema(value: unknown): value is z.ZodTypeAny {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const def = (value as { _def?: { typeName?: string } })._def;
  return typeof def?.typeName === "string";
}

export interface CreateToolInput<I, O> {
  id: string;
  description: string;
  // biome-ignore lint/suspicious/noExplicitAny: same as ToolDefinition above — _def and _input must be `any` to accept schemas with .default()/.transform()
  inputSchema: z.ZodType<I, any, any>;
  outputSchema: z.ZodType<O>;
  execute: (input: I, ctx: ToolContext) => Promise<O>;
  permission?: PermissionRule;
  timeoutMs?: number;
  maxMemoryMB?: number;
  tags?: string[];
}

export function createTool<I, O>(
  def: CreateToolInput<I, O>,
): ToolDefinition<I, O> {
  if (!ID_PATTERN.test(def.id)) {
    throw new Error(
      `Tool id must be in format "namespace.name" (lowercase, dot-separated, at least two segments): got "${def.id}"`,
    );
  }
  if (!def.description || def.description.trim().length === 0) {
    throw new Error(`Tool "${def.id}" must have a non-empty description`);
  }
  if (!isZodSchema(def.inputSchema)) {
    throw new Error(`Tool "${def.id}" inputSchema must be a Zod schema`);
  }
  if (!isZodSchema(def.outputSchema)) {
    throw new Error(`Tool "${def.id}" outputSchema must be a Zod schema`);
  }
  if (typeof def.execute !== "function") {
    throw new Error(`Tool "${def.id}" execute must be a function`);
  }

  const tool: ToolDefinition<I, O> = {
    id: def.id,
    description: def.description,
    inputSchema: def.inputSchema,
    outputSchema: def.outputSchema,
    execute: def.execute,
    permission: def.permission,
    timeoutMs: def.timeoutMs ?? 60000,
    maxMemoryMB: def.maxMemoryMB ?? 512,
    tags: def.tags ? Object.freeze([...def.tags]) : Object.freeze([]),
  };
  return Object.freeze(tool);
}

export function toLLMTool<I, O>(def: ToolDefinition<I, O>): LLMToolDefinition {
  const parameters = zodToJsonSchema(def.inputSchema as z.ZodTypeAny) as object;
  const timeoutSec = Math.ceil(def.timeoutMs / 1000);
  return {
    type: "function",
    function: {
      name: def.id,
      description: `${def.description}\n\nTimeout: ${timeoutSec}s`,
      parameters,
    },
  };
}
