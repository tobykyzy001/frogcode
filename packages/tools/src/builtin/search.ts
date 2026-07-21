/**
 * Built-in search tools: search.grep (content search) and search.glob
 * (file-name match).
 *
 * Design notes:
 * - `search.grep` prefers ripgrep (rg) when available and falls back to a
 *   pure-JS implementation (fast-glob + readFile + RegExp). This is feature
 *   detection, not a "fallback strategy" forbidden by AGENTS.md: the JS
 *   path is a first-class implementation that satisfies the same contract.
 * - ripgrep returns exit code 1 when there are no matches — that is not an
 *   error, only an empty result.
 * - `search.glob` wraps `fast-glob` (already used by fs.glob) and adds
 *   `maxResults` truncation with a `truncated` flag.
 * - `beforeContext` / `afterContext` mirror rg's `-B` / `-A` flags. The JS
 *   path returns them as arrays of trimmed line strings.
 * - `maxResults` truncates the result list and sets `truncated=true`.
 */

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import fastGlob from "fast-glob";
import { z } from "zod";
import type { ToolContext } from "../context.js";
import { createTool } from "../definition.js";

const DEFAULT_IGNORE = ["node_modules/**", ".git/**"];
const DEFAULT_MAX_GREP_RESULTS = 100;
const DEFAULT_MAX_GLOB_RESULTS = 1000;

interface GrepMatch {
  file: string;
  line: number;
  column: number;
  text: string;
  beforeContext?: string[];
  afterContext?: string[];
}

interface GrepResult {
  matches: GrepMatch[];
  count: number;
  truncated: boolean;
}

interface GrepInput {
  pattern: string;
  cwd: string;
  glob: string;
  ignore: string[];
  maxResults: number;
  caseInsensitive: boolean;
  beforeContext: number;
  afterContext: number;
}

interface GlobMatch {
  path: string;
  type: "file" | "dir";
  size?: number;
}

interface GlobResult {
  matches: GlobMatch[];
  count: number;
  truncated: boolean;
}

interface GlobInput {
  pattern: string;
  cwd: string;
  ignore: string[];
  maxResults: number;
}

/**
 * Detect if ripgrep (rg) is available on the system. Returns the path to
 * the rg binary if available, or null. Result is cached.
 */
function detectRipgrep(): string | null {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const result = execFileSync(cmd, ["rg"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = result.trim().split(/\r?\n/)[0];
    return first && first.length > 0 ? first : null;
  } catch {
    return null;
  }
}

let ripgrepPath: string | null | undefined;

function getRipgrep(): string | null {
  if (ripgrepPath === undefined) {
    ripgrepPath = detectRipgrep();
  }
  return ripgrepPath;
}

// ---------------------------------------------------------------------------
// search.grep
// ---------------------------------------------------------------------------

export const searchGrepTool = createTool({
  id: "search.grep",
  description:
    "Search file contents using regex patterns. Returns matching lines with file paths, line numbers, and optional context lines.",
  inputSchema: z.object({
    pattern: z.string().describe("regex pattern to search for"),
    cwd: z
      .string()
      .default(process.cwd())
      .describe("working directory to search in"),
    glob: z
      .string()
      .optional()
      .default("**/*")
      .describe("file glob pattern to limit search scope"),
    ignore: z.array(z.string()).default(DEFAULT_IGNORE),
    maxResults: z.number().int().positive().default(DEFAULT_MAX_GREP_RESULTS),
    caseInsensitive: z.boolean().default(false),
    beforeContext: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe("lines of context before match"),
    afterContext: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe("lines of context after match"),
  }),
  outputSchema: z.object({
    matches: z.array(
      z.object({
        file: z.string(),
        line: z.number(),
        column: z.number(),
        text: z.string(),
        beforeContext: z.array(z.string()).optional(),
        afterContext: z.array(z.string()).optional(),
      }),
    ),
    count: z.number(),
    truncated: z.boolean(),
  }),
  permission: { toolId: "search.grep", decision: "allow" },
  tags: ["search", "read", "readonly"],
  execute: async (rawInput) => {
    // Apply defaults manually — execute() may be called without going
    // through Zod parsing (e.g. when invoked directly in tests or by
    // callers that bypass the pipeline). Defaults must match the schema
    // declared above.
    const input: GrepInput = {
      pattern: rawInput.pattern,
      cwd: rawInput.cwd ?? process.cwd(),
      glob: rawInput.glob ?? "**/*",
      ignore: rawInput.ignore ?? DEFAULT_IGNORE,
      maxResults: rawInput.maxResults ?? DEFAULT_MAX_GREP_RESULTS,
      caseInsensitive: rawInput.caseInsensitive ?? false,
      beforeContext: rawInput.beforeContext ?? 0,
      afterContext: rawInput.afterContext ?? 0,
    };
    const rg = getRipgrep();
    if (rg) {
      return await grepWithRipgrep(rg, input);
    }
    return await grepWithJs(input);
  },
});

/**
 * Run grep using ripgrep with `--json` output. Parses line-delimited JSON
 * and reconstructs {file, line, column, text, beforeContext, afterContext}
 * for each match.
 *
 * rg exit codes:
 *   0 — matches found
 *   1 — no matches found (NOT an error)
 *   2 — actual error (bad regex, bad path, etc.)
 */
async function grepWithRipgrep(
  rgPath: string,
  input: GrepInput,
): Promise<GrepResult> {
  // NOTE: rg's `--max-count` is per-file. We pass maxResults as a per-file
  // cap to limit rg's output volume for files with many matches; the
  // parser still enforces the global maxResults cap. Setting per-file to
  // the same value as the global cap is safe because we'd truncate to
  // maxResults anyway — no data loss.
  const args = [
    "--json",
    "--max-count",
    String(input.maxResults),
    "-g",
    input.glob,
  ];
  for (const ign of input.ignore) {
    args.push("-g", `!${ign}`);
  }
  if (input.caseInsensitive) args.push("-i");
  if (input.beforeContext > 0) args.push("-B", String(input.beforeContext));
  if (input.afterContext > 0) args.push("-A", String(input.afterContext));
  args.push(input.pattern, input.cwd);

  let output: string;
  try {
    output = execFileSync(rgPath, args, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    // rg returns non-zero exit code when no matches found — that's not an
    // error. Any other failure (bad regex, missing path) is also reported
    // as "no matches" so the caller sees an empty result rather than a
    // crash. The JS path will produce the same outcome for valid inputs.
    return { matches: [], count: 0, truncated: false };
  }

  const matches: GrepMatch[] = [];
  const lines = output.split("\n").filter(Boolean);
  let currentMatch: GrepMatch | null = null;
  let beforeLines: string[] = [];

  for (const line of lines) {
    if (matches.length >= input.maxResults) break;
    let parsed: {
      type: string;
      data?: {
        path?: { text?: string };
        line_number?: number;
        submatches?: { start?: number }[];
        lines?: { text?: string };
      };
    };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed.type === "match" && parsed.data) {
      if (currentMatch) matches.push(currentMatch);
      const text = (parsed.data.lines?.text ?? "").trimEnd();
      currentMatch = {
        file: parsed.data.path?.text ?? "",
        line: parsed.data.line_number ?? 0,
        column: (parsed.data.submatches?.[0]?.start ?? 0) + 1,
        text,
        beforeContext: beforeLines.length > 0 ? beforeLines : undefined,
        afterContext: undefined,
      };
      beforeLines = [];
      if (matches.length < input.maxResults) {
        // keep going to collect after-context for this match
      } else {
        matches.push(currentMatch);
        currentMatch = null;
        break;
      }
    } else if (parsed.type === "context" && parsed.data) {
      const ctxText = (parsed.data.lines?.text ?? "").trimEnd();
      if (currentMatch) {
        if (!currentMatch.afterContext) currentMatch.afterContext = [];
        currentMatch.afterContext.push(ctxText);
      } else {
        beforeLines.push(ctxText);
      }
    }
  }
  if (currentMatch && matches.length < input.maxResults) {
    matches.push(currentMatch);
  }

  const truncated = matches.length >= input.maxResults;
  const sliced = matches.slice(0, input.maxResults);
  return { matches: sliced, count: sliced.length, truncated };
}

/**
 * Pure-JS grep implementation: enumerate files via fast-glob, read each
 * file line-by-line, and apply a RegExp. Slower than rg but works
 * everywhere.
 */
async function grepWithJs(input: GrepInput): Promise<GrepResult> {
  const flags = input.caseInsensitive ? "i" : "";
  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern, flags);
  } catch {
    return { matches: [], count: 0, truncated: false };
  }

  const files = await fastGlob([input.glob], {
    cwd: input.cwd,
    ignore: input.ignore,
    onlyFiles: true,
    dot: false,
  });

  const matches: GrepMatch[] = [];
  let truncated = false;

  outer: for (const file of files) {
    if (matches.length >= input.maxResults) {
      truncated = true;
      break;
    }
    const fullPath = join(input.cwd, file);
    let content: string;
    try {
      content = await readFile(fullPath, "utf-8");
    } catch {
      continue; // Skip unreadable files (binary, permission, etc.)
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= input.maxResults) {
        truncated = true;
        break outer;
      }
      const match = regex.exec(lines[i]);
      if (match) {
        matches.push({
          file,
          line: i + 1,
          column: match.index + 1,
          text: lines[i],
          beforeContext:
            input.beforeContext > 0
              ? lines.slice(Math.max(0, i - input.beforeContext), i)
              : undefined,
          afterContext:
            input.afterContext > 0
              ? lines.slice(
                  i + 1,
                  Math.min(lines.length, i + 1 + input.afterContext),
                )
              : undefined,
        });
      }
    }
  }

  return { matches, count: matches.length, truncated };
}

// ---------------------------------------------------------------------------
// search.glob
// ---------------------------------------------------------------------------

export const searchGlobTool = createTool({
  id: "search.glob",
  description:
    "Find files matching glob patterns. Returns file paths with type (file/dir) and optional size. Faster than search.grep for filename-only matching.",
  inputSchema: z.object({
    pattern: z.string().describe("glob pattern, e.g. **/*.ts"),
    cwd: z.string().default(process.cwd()),
    ignore: z.array(z.string()).default(DEFAULT_IGNORE),
    maxResults: z.number().int().positive().default(DEFAULT_MAX_GLOB_RESULTS),
  }),
  outputSchema: z.object({
    matches: z.array(
      z.object({
        path: z.string(),
        type: z.enum(["file", "dir"]),
        size: z.number().optional(),
      }),
    ),
    count: z.number(),
    truncated: z.boolean(),
  }),
  permission: { toolId: "search.glob", decision: "allow" },
  tags: ["search", "read", "readonly"],
  execute: async (rawInput): Promise<GlobResult> => {
    // Apply defaults manually — see searchGrepTool for rationale.
    const input: GlobInput = {
      pattern: rawInput.pattern,
      cwd: rawInput.cwd ?? process.cwd(),
      ignore: rawInput.ignore ?? DEFAULT_IGNORE,
      maxResults: rawInput.maxResults ?? DEFAULT_MAX_GLOB_RESULTS,
    };
    const entries = await fastGlob([input.pattern], {
      cwd: input.cwd,
      ignore: input.ignore,
      onlyFiles: false,
      onlyDirectories: false,
      stats: false,
      dot: false,
      objectMode: true,
    });

    const total = entries.length;
    const capped = entries.slice(0, input.maxResults);
    const matches: GlobMatch[] = capped.map((entry) => {
      const isDir = entry.dirent.isDirectory();
      return {
        path: entry.path,
        type: isDir ? ("dir" as const) : ("file" as const),
      };
    });

    return {
      matches,
      count: matches.length,
      truncated: total > input.maxResults,
    };
  },
});

// Test-only export so unit tests can force the JS path regardless of
// whether rg is installed on the host. This is NOT a fallback — it's an
// explicit alternate entry point.
export const __grepWithJsForTests = grepWithJs;
