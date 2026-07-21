import { z } from "zod";

// Simple input schemas
export const simpleStringInput = z.object({
  message: z.string(),
});

export const simpleNumberInput = z.object({
  count: z.number().int().positive(),
});

export const simpleBoolInput = z.object({
  enabled: z.boolean(),
});

// Complex input with multiple field types
export const complexInput = z.object({
  path: z.string().describe("file path"),
  encoding: z.enum(["utf-8", "base64", "hex"]).default("utf-8"),
  maxBytes: z.number().int().positive().default(1024),
  flags: z.array(z.string()).optional(),
  metadata: z.record(z.string()).optional(),
});

// Nested output schema
export const nestedOutput = z.object({
  status: z.enum(["ok", "error"]),
  data: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        value: z.unknown(),
      }),
    ),
    total: z.number(),
  }),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

export const TEST_TOOL_IDS = {
  simple: "test.echo",
  fs: "fs.read",
  shell: "shell.exec",
  http: "http.request",
  search: "search.grep",
} as const;

export const TEST_TOOL_TAGS = {
  readonly: ["readonly", "safe"],
  write: ["write", "destructive"],
  network: ["network"],
  shell: ["shell", "subprocess"],
} as const;
