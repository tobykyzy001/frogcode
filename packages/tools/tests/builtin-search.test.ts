import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../src/context.js";
import {
  searchGlobTool,
  searchGrepTool,
  __grepWithJsForTests,
} from "../src/index.js";

const ctx = {} as ToolContext;

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "frogcode-search-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("search.grep — basic", () => {
  it("finds a simple pattern in a file", async () => {
    await writeFile(join(tempDir, "a.ts"), "hello world\nfoo bar\n");
    const result = await searchGrepTool.execute(
      { pattern: "hello", cwd: tempDir },
      ctx,
    );
    expect(result.count).toBe(1);
    expect(result.matches[0].file).toMatch(/a\.ts$/);
    expect(result.matches[0].line).toBe(1);
    expect(result.matches[0].text).toContain("hello world");
    expect(result.matches[0].column).toBe(1);
  });

  it("returns count and truncated=false when under maxResults", async () => {
    for (let i = 0; i < 5; i++) {
      await writeFile(join(tempDir, `f${i}.ts`), "match line\n");
    }
    const result = await searchGrepTool.execute(
      { pattern: "match", cwd: tempDir },
      ctx,
    );
    expect(result.count).toBe(5);
    expect(result.truncated).toBe(false);
  });

  it("respects caseInsensitive flag", async () => {
    await writeFile(join(tempDir, "a.txt"), "Hello\nhello\nHELLO\n");
    const ci = await searchGrepTool.execute(
      { pattern: "hello", cwd: tempDir, caseInsensitive: false },
      ctx,
    );
    expect(ci.count).toBe(1);
    expect(ci.matches[0].line).toBe(2);

    const cs = await searchGrepTool.execute(
      { pattern: "hello", cwd: tempDir, caseInsensitive: true },
      ctx,
    );
    expect(cs.count).toBe(3);
  });

  it("respects glob filter (only *.ts files)", async () => {
    await writeFile(join(tempDir, "a.ts"), "match\n");
    await writeFile(join(tempDir, "b.js"), "match\n");
    const result = await searchGrepTool.execute(
      { pattern: "match", cwd: tempDir, glob: "**/*.ts" },
      ctx,
    );
    expect(result.count).toBe(1);
    const files = result.matches.map((m) => m.file);
    expect(files.some((f) => f.endsWith("a.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("b.js"))).toBe(false);
  });

  it("respects ignore list (skips node_modules/**)", async () => {
    await mkdir(join(tempDir, "node_modules"), { recursive: true });
    await writeFile(join(tempDir, "node_modules", "x.ts"), "match\n");
    await writeFile(join(tempDir, "keep.ts"), "match\n");
    const result = await searchGrepTool.execute(
      {
        pattern: "match",
        cwd: tempDir,
        ignore: ["node_modules/**"],
      },
      ctx,
    );
    expect(result.count).toBe(1);
    expect(result.matches[0].file).toMatch(/keep\.ts$/);
  });

  it("supports regex patterns (e.g. \\d+)", async () => {
    await writeFile(join(tempDir, "a.txt"), "foo123bar\n");
    const result = await searchGrepTool.execute(
      { pattern: "\\d+", cwd: tempDir },
      ctx,
    );
    expect(result.count).toBe(1);
    expect(result.matches[0].text).toContain("foo123bar");
  });

  it("captures beforeContext and afterContext", async () => {
    await writeFile(
      join(tempDir, "ctx.txt"),
      "line1\nline2\nline3\nline4\nline5\n",
    );
    const result = await searchGrepTool.execute(
      {
        pattern: "line3",
        cwd: tempDir,
        beforeContext: 1,
        afterContext: 1,
      },
      ctx,
    );
    expect(result.count).toBe(1);
    const m = result.matches[0];
    expect(m.line).toBe(3);
    expect(m.beforeContext).toEqual(["line2"]);
    expect(m.afterContext).toEqual(["line4"]);
  });
});

describe("search.grep — truncation", () => {
  it("truncates at maxResults and sets truncated=true", async () => {
    for (let i = 0; i < 50; i++) {
      await writeFile(join(tempDir, `f${String(i).padStart(2, "0")}.ts`), "match\n");
    }
    const result = await searchGrepTool.execute(
      { pattern: "match", cwd: tempDir, maxResults: 10 },
      ctx,
    );
    expect(result.matches.length).toBe(10);
    expect(result.count).toBe(10);
    expect(result.truncated).toBe(true);
  });

  it("does not truncate when results <= maxResults", async () => {
    for (let i = 0; i < 3; i++) {
      await writeFile(join(tempDir, `f${i}.ts`), "match\n");
    }
    const result = await searchGrepTool.execute(
      { pattern: "match", cwd: tempDir, maxResults: 100 },
      ctx,
    );
    expect(result.matches.length).toBe(3);
    expect(result.truncated).toBe(false);
  });
});

describe("search.grep — JS fallback path", () => {
  it("__grepWithJsForTests finds a simple pattern", async () => {
    await writeFile(join(tempDir, "a.ts"), "hello world\n");
    const result = await __grepWithJsForTests({
      pattern: "hello",
      cwd: tempDir,
      glob: "**/*",
      ignore: ["node_modules/**", ".git/**"],
      maxResults: 100,
      caseInsensitive: false,
      beforeContext: 0,
      afterContext: 0,
    });
    expect(result.count).toBe(1);
    expect(result.matches[0].file).toMatch(/a\.ts$/);
    expect(result.matches[0].line).toBe(1);
    expect(result.matches[0].column).toBe(1);
  });

  it("__grepWithJsForTests handles beforeContext/afterContext", async () => {
    await writeFile(
      join(tempDir, "ctx.txt"),
      "line1\nline2\nline3\nline4\nline5\n",
    );
    const result = await __grepWithJsForTests({
      pattern: "line3",
      cwd: tempDir,
      glob: "**/*",
      ignore: ["node_modules/**", ".git/**"],
      maxResults: 100,
      caseInsensitive: false,
      beforeContext: 1,
      afterContext: 1,
    });
    expect(result.count).toBe(1);
    expect(result.matches[0].beforeContext).toEqual(["line2"]);
    expect(result.matches[0].afterContext).toEqual(["line4"]);
  });

  it("__grepWithJsForTests truncates at maxResults", async () => {
    for (let i = 0; i < 20; i++) {
      await writeFile(join(tempDir, `f${String(i).padStart(2, "0")}.ts`), "match\n");
    }
    const result = await __grepWithJsForTests({
      pattern: "match",
      cwd: tempDir,
      glob: "**/*",
      ignore: ["node_modules/**", ".git/**"],
      maxResults: 5,
      caseInsensitive: false,
      beforeContext: 0,
      afterContext: 0,
    });
    expect(result.matches.length).toBe(5);
    expect(result.truncated).toBe(true);
  });
});

describe("search.glob — basic", () => {
  it("matches .ts files", async () => {
    await writeFile(join(tempDir, "a.ts"), "");
    await writeFile(join(tempDir, "b.ts"), "");
    await writeFile(join(tempDir, "c.js"), "");
    const result = await searchGlobTool.execute(
      { pattern: "**/*.ts", cwd: tempDir },
      ctx,
    );
    expect(result.count).toBe(2);
    const paths = result.matches.map((m) => m.path);
    expect(paths.some((p) => p.endsWith("a.ts"))).toBe(true);
    expect(paths.some((p) => p.endsWith("b.ts"))).toBe(true);
    expect(paths.some((p) => p.endsWith("c.js"))).toBe(false);
  });

  it("returns count", async () => {
    for (let i = 0; i < 5; i++) {
      await writeFile(join(tempDir, `f${i}.ts`), "");
    }
    const result = await searchGlobTool.execute(
      { pattern: "**/*.ts", cwd: tempDir },
      ctx,
    );
    expect(result.count).toBe(5);
    expect(result.matches.length).toBe(5);
    expect(result.truncated).toBe(false);
  });

  it("respects ignore list", async () => {
    await mkdir(join(tempDir, "node_modules"), { recursive: true });
    await writeFile(join(tempDir, "node_modules", "x.ts"), "");
    await writeFile(join(tempDir, "keep.ts"), "");
    const result = await searchGlobTool.execute(
      {
        pattern: "**/*.ts",
        cwd: tempDir,
        ignore: ["node_modules/**"],
      },
      ctx,
    );
    expect(result.count).toBe(1);
    expect(result.matches[0].path).toMatch(/keep\.ts$/);
  });

  it("truncates at maxResults with truncated=true", async () => {
    for (let i = 0; i < 50; i++) {
      await writeFile(join(tempDir, `f${String(i).padStart(2, "0")}.ts`), "");
    }
    const result = await searchGlobTool.execute(
      { pattern: "**/*.ts", cwd: tempDir, maxResults: 10 },
      ctx,
    );
    expect(result.matches.length).toBe(10);
    expect(result.truncated).toBe(true);
  });

  it("classifies entries as file vs dir", async () => {
    await mkdir(join(tempDir, "subdir"), { recursive: true });
    // fast-glob only returns directories that contain at least one entry
    // (matches `**/*` against contents), so we add a file inside subdir.
    await writeFile(join(tempDir, "subdir", "inside.ts"), "");
    await writeFile(join(tempDir, "file.ts"), "");
    const result = await searchGlobTool.execute(
      { pattern: "**/*", cwd: tempDir, ignore: [] },
      ctx,
    );
    const paths = result.matches.map((m) => m.path);
    const types = new Set(result.matches.map((m) => m.type));
    expect(paths.some((p) => p.endsWith("file.ts"))).toBe(true);
    expect(paths.some((p) => p.endsWith("subdir"))).toBe(true);
    expect(types.has("file")).toBe(true);
    expect(types.has("dir")).toBe(true);
  });
});
