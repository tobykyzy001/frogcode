import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellExecTool, evaluateRisk, shellRiskRule } from "../src/builtin/shell.js";
import type { ToolContext } from "../src/context.js";

const ctx = {} as ToolContext;

const isWindows = process.platform === "win32";

describe("evaluateRisk", () => {
  it("classifies readonly commands as 'low'", () => {
    expect(evaluateRisk("ls -la")).toBe("low");
    expect(evaluateRisk("git status")).toBe("low");
    expect(evaluateRisk("git log --oneline -5")).toBe("low");
    expect(evaluateRisk("echo hello")).toBe("low");
    expect(evaluateRisk("pwd")).toBe("low");
    expect(evaluateRisk("cat README.md")).toBe("low");
  });

  it("classifies destructive commands as 'high'", () => {
    expect(evaluateRisk("rm -rf /")).toBe("high");
    expect(evaluateRisk("rm -rf /home")).toBe("high");
    expect(evaluateRisk("rm -rf ~")).toBe("high");
    expect(evaluateRisk("rm -rf ~/foo")).toBe("high");
    expect(evaluateRisk("rm -rf $HOME")).toBe("high");
    expect(evaluateRisk("mkfs.ext4 /dev/sda1")).toBe("high");
    expect(evaluateRisk("dd if=/dev/zero of=/dev/sda")).toBe("high");
    expect(evaluateRisk(":(){ :|:& };:")).toBe("high");
    expect(evaluateRisk("chmod -R 777 /")).toBe("high");
    expect(evaluateRisk("shutdown -h now")).toBe("high");
    expect(evaluateRisk("reboot")).toBe("high");
  });

  it("classifies other commands as 'medium'", () => {
    expect(evaluateRisk("npm install")).toBe("medium");
    expect(evaluateRisk("pnpm build")).toBe("medium");
    expect(evaluateRisk("rm file.txt")).toBe("medium");
    expect(evaluateRisk("git push origin main")).toBe("medium");
  });

  it("treats empty / whitespace-only commands as 'medium'", () => {
    expect(evaluateRisk("")).toBe("medium");
    expect(evaluateRisk("   ")).toBe("medium");
  });

  it("classifies chained readonly commands as 'low'", () => {
    expect(evaluateRisk("ls; pwd")).toBe("low");
    expect(evaluateRisk("git status && git log")).toBe("low");
    expect(evaluateRisk("cat foo.txt | grep bar")).toBe("low");
  });

  it("flags high-risk patterns even when starting with a safe prefix", () => {
    expect(evaluateRisk("echo hi && rm -rf /")).toBe("high");
    expect(evaluateRisk("ls && rm -rf ~")).toBe("high");
    // `echo rm -rf /` contains a destructive pattern — classified as high
    // even though the leading `echo` would make it a no-op if executed
    // verbatim. This is the safe default: the destructive fragment could
    // be redirected to a shell via a pipe.
    expect(evaluateRisk("echo rm -rf /")).toBe("high");
  });
});

describe("shellRiskRule", () => {
  it("auto-approves low-risk commands", () => {
    const result = shellRiskRule.evaluate({ cmd: "ls -la" }, ctx);
    expect(result).not.toBeNull();
    expect(result?.allowed).toBe(true);
  });

  it("denies high-risk commands with a reason", () => {
    const result = shellRiskRule.evaluate({ cmd: "rm -rf /" }, ctx);
    expect(result).not.toBeNull();
    expect(result?.allowed).toBe(false);
    expect(result?.reason).toMatch(/dangerous/i);
  });

  it("returns null for medium-risk commands (fall through to ask)", () => {
    const result = shellRiskRule.evaluate({ cmd: "npm install" }, ctx);
    expect(result).toBeNull();
  });

  it("returns null for non-string cmd", () => {
    expect(shellRiskRule.evaluate({ cmd: 42 }, ctx)).toBeNull();
    expect(shellRiskRule.evaluate({}, ctx)).toBeNull();
    expect(shellRiskRule.evaluate(null, ctx)).toBeNull();
    expect(shellRiskRule.evaluate(undefined, ctx)).toBeNull();
  });
});

describe("shell.exec tool", () => {
  it("executes `echo hello` and returns exitCode 0 with stdout", async () => {
    const result = await shellExecTool.execute({ cmd: "echo hello" }, ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.cmd).toBe("echo hello");
    expect(result.risk).toBe("low");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.timedOut).toBe(false);
  });

  it("executes a listing command in a given cwd", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "frogcode-shell-"));
    try {
      writeFileSync(join(tmp, "marker-frog.txt"), "x");
      const listCmd = isWindows ? "dir /b" : "ls";
      const result = await shellExecTool.execute(
        { cmd: listCmd, cwd: tmp },
        ctx,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("marker-frog.txt");
      expect(result.risk).toBe("low");
      expect(result.timedOut).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("flags destructive-looking command as high-risk without refusing to run", async () => {
    // `echo rm -rf /` is harmless to execute (just prints the string) but
    // is classified as "high" because the destructive pattern appears
    // anywhere in the command. The tool itself does NOT enforce the
    // permission — that's the pipeline's job — so it still runs and
    // returns the printed output.
    const cmd = "echo rm -rf /";
    const result = await shellExecTool.execute({ cmd }, ctx);
    expect(result.risk).toBe("high");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("rm -rf /");
    expect(result.timedOut).toBe(false);
  });

  it("times out and kills the process when timeoutMs elapses", async () => {
    // Cross-platform long-running command via node.
    const cmd = isWindows
      ? 'node -e "setTimeout(function(){},10000)"'
      : "node -e 'setTimeout(function(){},10000)'";
    const result = await shellExecTool.execute(
      { cmd, timeoutMs: 100 },
      ctx,
    );
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(-1);
    // Duration should be roughly the timeout, not the full 10s.
    expect(result.durationMs).toBeLessThan(5000);
  }, 15000);

  it("captures stderr separately from stdout", async () => {
    // `echo error 1>&2` writes 'error' to stderr in both cmd.exe and sh.
    const result = await shellExecTool.execute(
      { cmd: "echo error 1>&2" },
      ctx,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("error");
    // stdout should NOT contain the error message (best-effort — some
    // shells echo to both, but the common case is stderr-only).
    expect(result.stdout).not.toContain("error");
    expect(result.timedOut).toBe(false);
  });

  it("treats non-zero exit code as success (returns result, not throw)", async () => {
    const result = await shellExecTool.execute(
      { cmd: "node -e \"process.exit(1)\"" },
      ctx,
    );
    expect(result.exitCode).toBe(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.cmd).toContain("process.exit(1)");
    expect(result.timedOut).toBe(false);
  });

  it("returns exitCode !== 0 when command not found", async () => {
    const result = await shellExecTool.execute(
      { cmd: "nonexistent-frogcode-command-xyz" },
      ctx,
    );
    // On Linux/sh this is 127; on Windows cmd.exe this is 1 or 9009.
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.timedOut).toBe(false);
  });

  it("passes environment variables to the child process", async () => {
    const cmd = isWindows
      ? 'node -e "console.log(process.env.FROG_TEST_VAR)"'
      : "node -e 'console.log(process.env.FROG_TEST_VAR)'";
    const result = await shellExecTool.execute(
      { cmd, env: { FROG_TEST_VAR: "ribbit-42" } },
      ctx,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ribbit-42");
    expect(result.timedOut).toBe(false);
  });

  it("truncates stdout beyond 1MB without crashing", async () => {
    // Generate ~2MB of output: 200000 * 11 bytes/line ≈ 2.2MB.
    const cmd = isWindows
      ? 'node -e "for(let i=0;i<200000;i++)process.stdout.write(\'hello\\n\')"'
      : "node -e 'for(let i=0;i<200000;i++)process.stdout.write(\"hello\\n\")'";
    const result = await shellExecTool.execute({ cmd }, ctx);
    expect(result.exitCode).toBe(0);
    // Truncation cap is 1MB; output must not exceed that.
    expect(Buffer.byteLength(result.stdout, "utf-8")).toBeLessThanOrEqual(
      1024 * 1024,
    );
    expect(result.timedOut).toBe(false);
  });
});

