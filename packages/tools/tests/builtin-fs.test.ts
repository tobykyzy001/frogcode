import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fsReadTool,
  fsWriteTool,
  fsGlobTool,
  type ToolContext,
} from "../src/index.js";

let tempDir: string;
let ctx: ToolContext;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "frogcode-test-"));
  ctx = { workingDirectory: tempDir };
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("fs.read", () => {
  it("reads a utf-8 text file", async () => {
    await writeFile(join(tempDir, "test.txt"), "hello world", "utf-8");
    const result = await fsReadTool.execute(
      { path: "test.txt", encoding: "utf-8", maxBytes: 1024 * 1024 },
      ctx,
    );
    expect(result.content).toBe("hello world");
    expect(result.bytes).toBe(11);
    expect(result.encoding).toBe("utf-8");
    expect(result.truncated).toBe(false);
    expect(result.path).toBe(join(tempDir, "test.txt"));
  });

  it("reads a file as base64", async () => {
    // "Hello" in bytes: 48 65 6c 6c 6f -> base64: SGVsbG8=
    await writeFile(join(tempDir, "bin.dat"), Buffer.from("Hello", "utf-8"));
    const result = await fsReadTool.execute(
      { path: "bin.dat", encoding: "base64", maxBytes: 1024 * 1024 },
      ctx,
    );
    expect(result.content).toBe("SGVsbG8=");
    expect(result.bytes).toBe(5);
    expect(result.encoding).toBe("base64");
    expect(result.truncated).toBe(false);
  });

  it("reads a file as hex", async () => {
    await writeFile(join(tempDir, "bin.dat"), Buffer.from([0x00, 0xff, 0x42]));
    const result = await fsReadTool.execute(
      { path: "bin.dat", encoding: "hex", maxBytes: 1024 * 1024 },
      ctx,
    );
    expect(result.content).toBe("00ff42");
    expect(result.bytes).toBe(3);
  });

  it("truncates large files when maxBytes is exceeded", async () => {
    // 2MB of data — exceeds the 1024-byte limit
    const big = Buffer.alloc(2 * 1024 * 1024, 0x41); // 'A'
    await writeFile(join(tempDir, "big.txt"), big);
    const result = await fsReadTool.execute(
      { path: "big.txt", encoding: "utf-8", maxBytes: 1024 },
      ctx,
    );
    expect(result.truncated).toBe(true);
    // `bytes` is the count of bytes returned in `content`, NOT the full
    // file size — large-file protection means we only read maxBytes.
    expect(result.bytes).toBe(1024);
    expect(result.content.length).toBe(1024);
    expect(result.content).toBe("A".repeat(1024));
  });

  it("throws on non-existent file", async () => {
    await expect(
      fsReadTool.execute(
        { path: "missing.txt", encoding: "utf-8", maxBytes: 1024 * 1024 },
        ctx,
      ),
    ).rejects.toThrow(/ENOENT|no such file/i);
  });

  it("respects workingDirectory for relative paths", async () => {
    await writeFile(join(tempDir, "relative.txt"), "abc", "utf-8");
    const result = await fsReadTool.execute(
      { path: "relative.txt", encoding: "utf-8", maxBytes: 1024 * 1024 },
      ctx,
    );
    expect(result.content).toBe("abc");
    expect(result.path).toBe(join(tempDir, "relative.txt"));
  });

  it("rejects path traversal via ..", async () => {
    await expect(
      fsReadTool.execute(
        {
          path: "../../../etc/passwd",
          encoding: "utf-8",
          maxBytes: 1024 * 1024,
        },
        ctx,
      ),
    ).rejects.toThrow(/escapes working directory/i);
  });
});

describe("fs.write", () => {
  it("creates a new file", async () => {
    const result = await fsWriteTool.execute(
      {
        path: "new.txt",
        content: "hello",
        createDirs: true,
        overwrite: false,
      },
      ctx,
    );
    expect(result.created).toBe(true);
    expect(result.overwritten).toBe(false);
    expect(result.bytes).toBe(5);
    expect(result.path).toBe(join(tempDir, "new.txt"));

    // Verify file contents on disk
    const { readFile } = await import("node:fs/promises");
    const onDisk = await readFile(join(tempDir, "new.txt"), "utf-8");
    expect(onDisk).toBe("hello");
  });

  it("creates parent directories when createDirs=true", async () => {
    const result = await fsWriteTool.execute(
      {
        path: "sub/dir/file.txt",
        content: "deep",
        createDirs: true,
        overwrite: false,
      },
      ctx,
    );
    expect(result.created).toBe(true);

    const { readFile } = await import("node:fs/promises");
    const onDisk = await readFile(
      join(tempDir, "sub", "dir", "file.txt"),
      "utf-8",
    );
    expect(onDisk).toBe("deep");
  });

  it("rejects overwrite when overwrite=false and file exists", async () => {
    await fsWriteTool.execute(
      {
        path: "exists.txt",
        content: "first",
        createDirs: true,
        overwrite: false,
      },
      ctx,
    );
    await expect(
      fsWriteTool.execute(
        {
          path: "exists.txt",
          content: "second",
          createDirs: true,
          overwrite: false,
        },
        ctx,
      ),
    ).rejects.toThrow(/already exists/i);
  });

  it("overwrites existing file when overwrite=true", async () => {
    await fsWriteTool.execute(
      {
        path: "ow.txt",
        content: "old",
        createDirs: true,
        overwrite: false,
      },
      ctx,
    );
    const result = await fsWriteTool.execute(
      {
        path: "ow.txt",
        content: "new",
        createDirs: true,
        overwrite: true,
      },
      ctx,
    );
    expect(result.overwritten).toBe(true);
    expect(result.created).toBe(false);
    expect(result.bytes).toBe(3);

    const { readFile } = await import("node:fs/promises");
    const onDisk = await readFile(join(tempDir, "ow.txt"), "utf-8");
    expect(onDisk).toBe("new");
  });

  it("rejects path traversal via ..", async () => {
    await expect(
      fsWriteTool.execute(
        {
          path: "../../../tmp/frogcode-evil.txt",
          content: "evil",
          createDirs: true,
          overwrite: false,
        },
        ctx,
      ),
    ).rejects.toThrow(/escapes working directory/i);
  });

  it("writes binary content via base64-decoded buffer manually", async () => {
    // Verify that the content string is written as utf-8 bytes
    const result = await fsWriteTool.execute(
      {
        path: "utf8.txt",
        content: "héllo", // contains a multi-byte char
        createDirs: true,
        overwrite: false,
      },
      ctx,
    );
    // "héllo" in utf-8 = h(0x68) é(0xc3 0xa9) l(0x6c) l(0x6c) o(0x6f) = 6 bytes
    expect(result.bytes).toBe(6);
  });
});

describe("fs.glob", () => {
  it("matches files by pattern", async () => {
    await writeFile(join(tempDir, "a.ts"), "", "utf-8");
    await writeFile(join(tempDir, "b.ts"), "", "utf-8");
    await writeFile(join(tempDir, "c.js"), "", "utf-8");

    const result = await fsGlobTool.execute(
      {
        pattern: "**/*.ts",
        cwd: tempDir,
        ignore: ["node_modules/**"],
      },
      ctx,
    );
    expect(result.count).toBe(2);
    const paths = result.matches.map((m) => m.path).sort();
    expect(paths).toEqual(["a.ts", "b.ts"]);
    for (const m of result.matches) {
      expect(m.type).toBe("file");
    }
  });

  it("respects the ignore option", async () => {
    await mkdir(join(tempDir, "node_modules"), { recursive: true });
    await writeFile(join(tempDir, "node_modules", "x.ts"), "", "utf-8");
    await writeFile(join(tempDir, "keep.ts"), "", "utf-8");

    const result = await fsGlobTool.execute(
      {
        pattern: "**/*.ts",
        cwd: tempDir,
        ignore: ["node_modules/**"],
      },
      ctx,
    );
    const paths = result.matches.map((m) => m.path);
    expect(paths).toContain("keep.ts");
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
  });

  it("returns count matching number of matches", async () => {
    await writeFile(join(tempDir, "f1.ts"), "", "utf-8");
    await writeFile(join(tempDir, "f2.ts"), "", "utf-8");
    await writeFile(join(tempDir, "f3.ts"), "", "utf-8");

    const result = await fsGlobTool.execute(
      {
        pattern: "**/*.ts",
        cwd: tempDir,
        ignore: ["node_modules/**"],
      },
      ctx,
    );
    expect(result.count).toBe(result.matches.length);
    expect(result.count).toBe(3);
  });

  it("classifies directories vs files", async () => {
    await mkdir(join(tempDir, "subdir"), { recursive: true });
    await writeFile(join(tempDir, "subdir", "inside.ts"), "", "utf-8");
    await writeFile(join(tempDir, "top.ts"), "", "utf-8");

    const result = await fsGlobTool.execute(
      {
        pattern: "**/*",
        cwd: tempDir,
        ignore: ["node_modules/**"],
      },
      ctx,
    );
    const types = result.matches.map((m) => m.type);
    expect(types).toContain("file");
    // fast-glob with mark:true and onlyFiles:false should report at least one dir
    expect(types).toContain("dir");
  });

  it("returns empty matches for non-matching pattern", async () => {
    await writeFile(join(tempDir, "a.ts"), "", "utf-8");
    const result = await fsGlobTool.execute(
      {
        pattern: "**/*.nonexistent",
        cwd: tempDir,
        ignore: ["node_modules/**"],
      },
      ctx,
    );
    expect(result.count).toBe(0);
    expect(result.matches).toEqual([]);
  });
});

describe("builtin exports", () => {
  it("exposes fsReadTool, fsWriteTool, fsGlobTool with correct ids", async () => {
    expect(fsReadTool.id).toBe("fs.read");
    expect(fsWriteTool.id).toBe("fs.write");
    expect(fsGlobTool.id).toBe("fs.glob");
  });

  it("builtinFsTools and builtinTools arrays include all three fs tools", async () => {
    const { builtinFsTools, builtinTools } = await import("../src/index.js");
    expect(builtinFsTools.length).toBe(3);
    // builtinTools is the union of all builtin tool groups (fs + http + shell +
    // search in Wave 3); we only assert that it includes the 3 fs tools.
    expect(builtinTools.length).toBeGreaterThanOrEqual(3);
    const fsIds = builtinFsTools.map((t) => t.id).sort();
    expect(fsIds).toEqual(["fs.glob", "fs.read", "fs.write"]);
    const allIds = builtinTools.map((t) => t.id);
    for (const id of fsIds) {
      expect(allIds).toContain(id);
    }
  });
});
