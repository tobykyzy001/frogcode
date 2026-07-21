/**
 * Built-in filesystem tools: fs.read, fs.write, fs.glob.
 *
 * Design notes:
 * - All paths are resolved against `ctx.workingDirectory` (falling back to
 *   `process.cwd()`). Absolute paths are honored but still must not escape
 *   the base via ".." traversal.
 * - `fs.read` defaults to 1MB maxBytes to prevent unbounded memory use.
 * - `fs.write` is non-destructive by default (`overwrite: false`) and
 *   creates parent directories with `mkdir({ recursive: true })`.
 * - `fs.glob` uses `fast-glob` v3 (v4 has breaking API changes).
 * - No fallback strategies: errors propagate to the caller (per AGENTS.md).
 */

import { mkdir, open, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import fastGlob from "fast-glob";
import { z } from "zod";
import type { ToolContext } from "../context.js";
import { type ToolDefinition, createTool } from "../definition.js";

const DEFAULT_MAX_BYTES = 1024 * 1024; // 1MB
const DEFAULT_IGNORE = ["node_modules/**"];

/**
 * Resolve a path relative to the tool context's workingDirectory (or
 * `process.cwd()` if unset). Rejects paths that escape the base via ".."
 * traversal — covers both relative ("../foo") and absolute paths whose
 * normalized form lands outside the working directory.
 */
function resolvePath(inputPath: string, ctx: ToolContext): string {
  const base = ctx.workingDirectory ?? process.cwd();
  const resolved = isAbsolute(inputPath) ? inputPath : join(base, inputPath);
  const rel = relative(base, resolved);
  if (rel.startsWith("..")) {
    throw new Error(
      `Path escapes working directory: ${inputPath} (resolved to ${resolved})`,
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// fs.read
// ---------------------------------------------------------------------------

export const fsReadTool = createTool({
  id: "fs.read",
  description:
    "Read file contents from the local filesystem. Returns text or base64-encoded content.",
  inputSchema: z.object({
    path: z
      .string()
      .describe(
        "absolute or relative file path (relative to workingDirectory)",
      ),
    encoding: z.enum(["utf-8", "base64", "hex"]).default("utf-8"),
    maxBytes: z.number().int().positive().default(DEFAULT_MAX_BYTES),
  }),
  outputSchema: z.object({
    path: z.string(),
    content: z.string(),
    bytes: z.number(),
    encoding: z.string(),
    truncated: z.boolean(),
  }),
  permission: { toolId: "fs.read", decision: "ask" },
  tags: ["filesystem", "read", "readonly"],
  execute: async (input, ctx) => {
    const fullPath = resolvePath(input.path, ctx);
    const stats = await stat(fullPath);
    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${input.path}`);
    }
    // Zod's `.default()` makes the input type optional in TypeScript's
    // inference, but the schema-parser layer guarantees the value is present
    // at runtime. We use `??` to provide the same default value (matches
    // the zod schema) without falling back on a different code path.
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
    const encoding = (input.encoding ?? "utf-8") as BufferEncoding;
    // Cap the read at maxBytes — never load the whole file into memory if it
    // exceeds the limit (large-file protection).
    const isTruncated = stats.size > maxBytes;
    const bytesToRead = Math.min(stats.size, maxBytes);
    const fd = await open(fullPath, "r");
    try {
      const buffer = Buffer.alloc(bytesToRead);
      await fd.read(buffer, 0, bytesToRead, 0);
      return {
        path: fullPath,
        content: buffer.toString(encoding),
        // `bytes` is the count of bytes returned in `content`, NOT the full
        // file size — callers can rely on `bytes === content.length` for
        // single-byte encodings, and use `truncated` to detect when more data
        // exists on disk.
        bytes: bytesToRead,
        encoding: input.encoding ?? "utf-8",
        truncated: isTruncated,
      };
    } finally {
      await fd.close();
    }
  },
});

// ---------------------------------------------------------------------------
// fs.write
// ---------------------------------------------------------------------------

export const fsWriteTool = createTool({
  id: "fs.write",
  description:
    "Write content to a file on the local filesystem. Creates parent directories by default. Does NOT overwrite by default.",
  inputSchema: z.object({
    path: z.string().describe("absolute or relative file path"),
    content: z.string(),
    createDirs: z.boolean().default(true),
    overwrite: z.boolean().default(false),
  }),
  outputSchema: z.object({
    path: z.string(),
    bytes: z.number(),
    created: z.boolean(),
    overwritten: z.boolean(),
  }),
  permission: { toolId: "fs.write", decision: "ask" },
  tags: ["filesystem", "write"],
  execute: async (input, ctx) => {
    const fullPath = resolvePath(input.path, ctx);

    // Detect existing file — only swallow ENOENT, propagate other errors.
    let existed = false;
    try {
      await stat(fullPath);
      existed = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }

    if (existed && !input.overwrite) {
      throw new Error(
        `File already exists (use overwrite=true to replace): ${fullPath}`,
      );
    }

    if (input.createDirs) {
      await mkdir(dirname(fullPath), { recursive: true });
    }

    const data = Buffer.from(input.content, "utf-8");
    await writeFile(fullPath, data);

    return {
      path: fullPath,
      bytes: data.byteLength,
      created: !existed,
      overwritten: existed && input.overwrite,
    };
  },
});

// ---------------------------------------------------------------------------
// fs.glob
// ---------------------------------------------------------------------------

export const fsGlobTool = createTool({
  id: "fs.glob",
  description:
    "Match file paths against glob patterns (e.g. **/*.ts). Returns matching file and directory paths.",
  inputSchema: z.object({
    pattern: z.string().describe("glob pattern, e.g. **/*.ts"),
    cwd: z.string().default(process.cwd()),
    ignore: z.array(z.string()).default(DEFAULT_IGNORE),
  }),
  outputSchema: z.object({
    matches: z.array(
      z.object({
        path: z.string(),
        type: z.enum(["file", "dir"]),
      }),
    ),
    count: z.number(),
  }),
  permission: { toolId: "fs.glob", decision: "allow" },
  tags: ["filesystem", "read", "readonly", "search"],
  execute: async (input, _ctx) => {
    // Zod `.default()` fields are present at runtime after schema parsing.
    // Use `??` to satisfy TypeScript without non-null assertions.
    const cwdInput = input.cwd ?? process.cwd();
    const cwd = isAbsolute(cwdInput) ? cwdInput : resolve(cwdInput);
    const ignore = input.ignore ?? DEFAULT_IGNORE;
    // objectMode returns Entry objects with dirent — lets us classify
    // file vs dir without a separate stat() call (avoids TOCTOU race).
    const entries = await fastGlob(input.pattern, {
      cwd,
      ignore,
      onlyFiles: false,
      dot: true,
      objectMode: true,
    });
    const matches = entries.map((entry) => ({
      // entry.path is the relative path from cwd (POSIX-separated by
      // fast-glob even on Windows); entry.name is just the basename.
      path: entry.path,
      type: entry.dirent.isDirectory() ? ("dir" as const) : ("file" as const),
    }));
    return {
      matches,
      count: matches.length,
    };
  },
});

// `ToolDefinition<I, O>` is invariant in `I` (execute uses it in a parameter
// position). A heterogeneous array of tools with different input shapes
// therefore cannot be typed as `ToolDefinition<unknown, unknown>[]`. We
// use `ToolDefinition<any, any>` — the standard TypeScript idiom for a
// registry of tools with heterogeneous input/output shapes. This does NOT
// weaken caller safety: each tool's own `inputSchema` (a Zod schema) is
// the source of truth for input validation at runtime.
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool array requires any-typed entries; runtime validation is provided by each tool's Zod inputSchema
export const fsTools: readonly ToolDefinition<any, any>[] = [
  fsReadTool,
  fsWriteTool,
  fsGlobTool,
];
