import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ForkSandbox,
  ToolTimeoutError,
  ToolMemoryError,
  ToolCrashError,
  type ForkSandboxOptions,
} from "../src/index.js";

/**
 * ForkSandbox tests use a REAL child_process.fork — no mocks.
 *
 * The worker script is the BUILT `dist/sandbox/sandbox-worker.mjs`
 * (compiled from `src/sandbox/sandbox-worker.ts` by tsup). Tests must run
 * `pnpm --filter @frogcode/tools build` first so the worker file exists.
 *
 * vitest loads the source TS directly, so `import.meta.url` inside
 * `fork-sandbox.ts` points into `src/` rather than `dist/`. That's why we
 * pass `workerPath` explicitly here — the default path resolution only
 * works when consuming the built package.
 */

const here = dirname(fileURLToPath(import.meta.url));
const workerPath = join(here, "..", "dist", "sandbox", "sandbox-worker.mjs");

function makeSandbox(
  opts: Partial<Pick<ForkSandboxOptions, "timeoutMs" | "maxMemoryMB">> = {},
): ForkSandbox {
  return new ForkSandbox({
    timeoutMs: opts.timeoutMs ?? 5000,
    maxMemoryMB: opts.maxMemoryMB ?? 256,
    workerPath,
  });
}

describe("ForkSandbox", () => {
  it("executes a simple script and returns the result", async () => {
    const sandbox = makeSandbox();
    const result = await sandbox.run(
      "module.exports = async (input) => ({ echo: input.msg })",
      { msg: "hello" },
    );
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ echo: "hello" });
  });

  it("returns ToolTimeoutError when script exceeds timeout", async () => {
    const sandbox = makeSandbox({ timeoutMs: 100 });
    const result = await sandbox.run(
      "module.exports = async () => { await new Promise(r => setTimeout(r, 5000)); return {} }",
      {},
    );
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("ToolTimeoutError");
    expect(result.error?.code).toBe("TOOL_TIMEOUT");
    expect(result.error?.timeoutMs).toBe(100);
  });

  it("returns ToolCrashError when script throws", async () => {
    const sandbox = makeSandbox();
    const result = await sandbox.run(
      "module.exports = async () => { throw new Error('crash') }",
      {},
    );
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("ToolCrashError");
    expect(result.error?.code).toBe("TOOL_CRASH");
    expect(result.error?.message).toBe("crash");
  });

  it("main process is unaffected after child crash", async () => {
    const sandbox1 = makeSandbox();
    await sandbox1.run(
      "module.exports = async () => { throw new Error('crash') }",
      {},
    );
    // If we got here, main process is alive
    const sandbox2 = makeSandbox();
    const result = await sandbox2.run(
      "module.exports = async (input) => ({ ok: true, value: input.x * 2 })",
      { x: 21 },
    );
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ ok: true, value: 42 });
  });

  it("returns an error when script exceeds memory limit", async () => {
    // Allocate a large array to trigger V8 OOM via --max-old-space-size=32
    const sandbox = makeSandbox({ timeoutMs: 15000, maxMemoryMB: 32 });
    const result = await sandbox.run(
      "module.exports = async () => { const arr = []; while(true) arr.push(new Array(1000000)); return { len: arr.length } }",
      {},
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    // V8 OOM may exit with code 134 (ToolMemoryError) or throw a RangeError
    // caught by the worker (ToolCrashError). Either is acceptable as long as
    // it's an error, not a success.
  }, 20000);

  it("handles script that doesn't export a function", async () => {
    const sandbox = makeSandbox();
    const result = await sandbox.run(
      "module.exports = { not: 'a function' }",
      {},
    );
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("SandboxError");
    expect(result.error?.code).toBe("INVALID_SCRIPT");
  });

  it("handles script with syntax error", async () => {
    const sandbox = makeSandbox();
    const result = await sandbox.run("this is not valid javascript", {});
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("SyntaxError");
  });

  it("preserves input data across the IPC boundary", async () => {
    const sandbox = makeSandbox();
    const input = {
      str: "hello",
      num: 42,
      bool: true,
      arr: [1, 2, 3],
      nested: { a: "b" },
      nil: null,
    };
    const result = await sandbox.run(
      "module.exports = async (input) => ({ mirror: input })",
      input,
    );
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ mirror: input });
  });

  it("rejects negative timeoutMs", () => {
    expect(
      () => new ForkSandbox({ timeoutMs: -1, maxMemoryMB: 256, workerPath }),
    ).toThrow(/timeoutMs must be positive/);
  });

  it("rejects zero maxMemoryMB", () => {
    expect(
      () => new ForkSandbox({ timeoutMs: 1000, maxMemoryMB: 0, workerPath }),
    ).toThrow(/maxMemoryMB must be positive/);
  });

  it("exports error class hierarchy", () => {
    expect(ToolTimeoutError).toBeInstanceOf(Function);
    expect(ToolMemoryError).toBeInstanceOf(Function);
    expect(ToolCrashError).toBeInstanceOf(Function);

    const timeoutErr = new ToolTimeoutError(100);
    expect(timeoutErr.code).toBe("TOOL_TIMEOUT");
    expect(timeoutErr.timeoutMs).toBe(100);
    expect(timeoutErr.name).toBe("ToolTimeoutError");

    const memErr = new ToolMemoryError(64);
    expect(memErr.code).toBe("TOOL_MEMORY");
    expect(memErr.maxMemoryMB).toBe(64);
    expect(memErr.name).toBe("ToolMemoryError");

    const crashErr = new ToolCrashError(1, null);
    expect(crashErr.code).toBe("TOOL_CRASH");
    expect(crashErr.exitCode).toBe(1);
    expect(crashErr.signal).toBeNull();
    expect(crashErr.name).toBe("ToolCrashError");
  });
});
