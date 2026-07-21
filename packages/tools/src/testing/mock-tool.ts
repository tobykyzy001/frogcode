import { z } from "zod";
import type { ToolContext } from "../context.js";
import { type ToolDefinition, createTool } from "../definition.js";

export interface MockToolConfig<I = unknown, O = unknown> {
  id?: string;
  description?: string;
  result?: O;
  error?: Error;
  delayMs?: number;
  inputSchema?: z.ZodType<I>;
  outputSchema?: z.ZodType<O>;
  tags?: string[];
  timeoutMs?: number;
  maxMemoryMB?: number;
}

export function createMockTool<I = unknown, O = unknown>(
  config: MockToolConfig<I, O> = {},
): ToolDefinition<I, O> {
  const inputSchema =
    config.inputSchema ?? (z.object({}) as unknown as z.ZodType<I>);
  const outputSchema =
    config.outputSchema ?? (z.unknown() as unknown as z.ZodType<O>);

  return createTool<I, O>({
    id: config.id ?? "mock.tool",
    description: config.description ?? "mock tool for testing",
    inputSchema,
    outputSchema,
    tags: config.tags,
    timeoutMs: config.timeoutMs,
    maxMemoryMB: config.maxMemoryMB,
    execute: async (_input: I, _ctx: ToolContext): Promise<O> => {
      if (config.delayMs && config.delayMs > 0) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, config.delayMs),
        );
      }
      if (config.error) {
        throw config.error;
      }
      return (config.result ?? ({ ok: true } as O)) as O;
    },
  });
}
