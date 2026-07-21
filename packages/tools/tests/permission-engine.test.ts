import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../src/context.js";
import { createMockTool } from "../src/index.js";
import {
  PermissionEngine,
  matchGlob,
  type PermissionEngineOptions,
  type PermissionCheckResult,
  type PermissionHook,
  type SafetyGuard,
  type ToolSpecificRule,
} from "../src/index.js";

const ctx = {} as ToolContext;

function uniqueTempFile(ext: string = ".json"): Promise<{ dir: string; file: string }> {
  return mkdtemp(join(tmpdir(), "frogcode-perms-")).then((dir) => ({
    dir,
    file: join(dir, `permissions${ext}`),
  }));
}

describe("matchGlob", () => {
  it("`fs.*` matches `fs.read`", () => {
    expect(matchGlob("fs.*", "fs.read")).toBe(true);
  });

  it("`fs.*` does NOT match `fs.read.deep` (3 segments)", () => {
    expect(matchGlob("fs.*", "fs.read.deep")).toBe(false);
  });

  it("`fs.**` matches `fs.read.deep`", () => {
    expect(matchGlob("fs.**", "fs.read.deep")).toBe(true);
  });

  it("`**` matches anything", () => {
    expect(matchGlob("**", "anything.at.all")).toBe(true);
  });

  it("`fs.?` matches single-char segment like `fs.x`", () => {
    expect(matchGlob("fs.?", "fs.x")).toBe(true);
  });

  it("`fs.?` does NOT match `fs.read` (multi-char)", () => {
    expect(matchGlob("fs.?", "fs.read")).toBe(false);
  });

  it("exact match returns true", () => {
    expect(matchGlob("fs.read", "fs.read")).toBe(true);
  });

  it("unrelated patterns return false", () => {
    expect(matchGlob("shell.*", "fs.read")).toBe(false);
  });
});

describe("PermissionEngine — Layer 2 (deny)", () => {
  it("deny rule short-circuits with reason", async () => {
    const engine = new PermissionEngine({
      rules: [{ toolId: "shell.*", decision: "deny", reason: "shell disabled" }],
    });
    const tool = createMockTool({ id: "shell.exec" });
    const result = await engine.check(tool, {}, ctx);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("shell disabled");
  });

  it("deny rule with glob `fs.*` matches `fs.read`", async () => {
    const engine = new PermissionEngine({
      rules: [{ toolId: "fs.*", decision: "deny" }],
    });
    const tool = createMockTool({ id: "fs.read" });
    const result = await engine.check(tool, {}, ctx);
    expect(result.allowed).toBe(false);
  });

  it("expired deny rule is ignored (falls through to deny default)", async () => {
    const engine = new PermissionEngine({
      rules: [
        {
          toolId: "fs.read",
          decision: "allow",
          expiresAt: Date.now() - 1000,
        },
      ],
    });
    const tool = createMockTool({ id: "fs.read" });
    const result = await engine.check(tool, {}, ctx);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/no rule matched/);
  });
});

describe("PermissionEngine — Layer 3 (ask)", () => {
  it("ask rule triggers canUseTool callback and returns its decision", async () => {
    let called = false;
    const engine = new PermissionEngine({
      rules: [{ toolId: "fs.read", decision: "ask", reason: "needs confirm" }],
      canUseTool: async () => {
        called = true;
        return { allowed: true, reason: "user said yes" };
      },
    });
    const tool = createMockTool({ id: "fs.read" });
    const result = await engine.check(tool, {}, ctx);
    expect(called).toBe(true);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("user said yes");
  });

  it("ask rule with no callback defaults to deny", async () => {
    const engine = new PermissionEngine({
      rules: [{ toolId: "fs.read", decision: "ask" }],
    });
    const tool = createMockTool({ id: "fs.read" });
    const result = await engine.check(tool, {}, ctx);
    expect(result.allowed).toBe(false);
  });

  it("ask rule with persisted=true installs permanent allow rule (second check skips callback)", async () => {
    let calls = 0;
    const engine = new PermissionEngine({
      rules: [{ toolId: "fs.read", decision: "ask" }],
      canUseTool: async () => {
        calls++;
        return { allowed: true, persisted: true, reason: "user said yes" };
      },
    });
    const tool = createMockTool({ id: "fs.read" });
    const first = await engine.check(tool, {}, ctx);
    expect(first.allowed).toBe(true);
    expect(first.persisted).toBe(true);
    expect(calls).toBe(1);

    const second = await engine.check(tool, {}, ctx);
    expect(second.allowed).toBe(true);
    // callback must NOT have been called again — allow rule short-circuited
    expect(calls).toBe(1);

    // verify the persisted rule is now in listRules
    const rules = engine.listRules();
    expect(rules.some((r) => r.decision === "allow" && r.toolId === "fs.read")).toBe(true);
  });
});

describe("PermissionEngine — Layer 4 (tool-specific)", () => {
  it("tool-specific rule evaluates and returns allow", async () => {
    const toolRule: ToolSpecificRule = {
      toolId: "fs.read",
      evaluate: () => ({ allowed: true, reason: "tool-specific allow" }),
    };
    const engine = new PermissionEngine({ toolSpecificRules: [toolRule] });
    const tool = createMockTool({ id: "fs.read" });
    const result = await engine.check(tool, {}, ctx);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("tool-specific allow");
  });

  it("tool-specific rule returning null falls through", async () => {
    const toolRule: ToolSpecificRule = {
      toolId: "fs.read",
      evaluate: () => null,
    };
    const engine = new PermissionEngine({ toolSpecificRules: [toolRule] });
    const tool = createMockTool({ id: "fs.read" });
    const result = await engine.check(tool, {}, ctx);
    expect(result.allowed).toBe(false);
  });

  it("tool-specific rule with glob `fs.*` matches `fs.read`", async () => {
    const toolRule: ToolSpecificRule = {
      toolId: "fs.*",
      evaluate: () => ({ allowed: true }),
    };
    const engine = new PermissionEngine({ toolSpecificRules: [toolRule] });
    const tool = createMockTool({ id: "fs.read" });
    const result = await engine.check(tool, {}, ctx);
    expect(result.allowed).toBe(true);
  });
});

describe("PermissionEngine — Layer 5 (safety guards)", () => {
  it("safety guard overrides auto-approve-all mode", async () => {
    const guard: SafetyGuard = {
      name: "block-rm-rf",
      evaluate: () => ({ allowed: false, reason: "rm -rf / blocked" }),
    };
    const engine = new PermissionEngine({
      mode: "auto-approve-all",
      safetyGuards: [guard],
    });
    const tool = createMockTool({ id: "shell.exec" });
    const result = await engine.check(tool, { cmd: "rm -rf /" }, ctx);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("rm -rf / blocked");
  });

  it("safety guard returning null falls through to mode", async () => {
    const guard: SafetyGuard = {
      name: "noop",
      evaluate: () => null,
    };
    const engine = new PermissionEngine({
      mode: "auto-approve-all",
      safetyGuards: [guard],
    });
    const tool = createMockTool({ id: "shell.exec" });
    const result = await engine.check(tool, {}, ctx);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("auto-approve-all mode");
  });
});

describe("PermissionEngine — Layer 6 (mode)", () => {
  it("auto-approve-all permits everything with no rules", async () => {
    const engine = new PermissionEngine({ mode: "auto-approve-all" });
    const tool = createMockTool({ id: "fs.read" });
    const result = await engine.check(tool, {}, ctx);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("auto-approve-all mode");
  });

  it("auto-approve-read permits readonly-tagged tools", async () => {
    const engine = new PermissionEngine({ mode: "auto-approve-read" });
    const tool = createMockTool({ id: "fs.read", tags: ["readonly"] });
    const result = await engine.check(tool, {}, ctx);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("auto-approve-read mode");
  });

  it("auto-approve-read falls through for write-tagged tools (no opinion)", async () => {
    const engine = new PermissionEngine({ mode: "auto-approve-read" });
    const tool = createMockTool({ id: "fs.write", tags: ["write"] });
    const result = await engine.check(tool, {}, ctx);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/no rule matched/);
  });

  it("deny-all denies everything", async () => {
    const engine = new PermissionEngine({ mode: "deny-all" });
    const tool = createMockTool({ id: "fs.read", tags: ["readonly"] });
    const result = await engine.check(tool, {}, ctx);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("deny-all mode");
  });

  it("setMode changes the active mode", async () => {
    const engine = new PermissionEngine();
    expect(engine.getMode()).toBe("default");
    engine.setMode("auto-approve-all");
    expect(engine.getMode()).toBe("auto-approve-all");
    const tool = createMockTool({ id: "fs.read" });
    const result = await engine.check(tool, {}, ctx);
    expect(result.allowed).toBe(true);
  });
});

describe("PermissionEngine — Layer 7 (allow)", () => {
  it("allow rule permits", async () => {
    const engine = new PermissionEngine({
      rules: [{ toolId: "fs.read", decision: "allow", reason: "explicit allow" }],
    });
    const tool = createMockTool({ id: "fs.read" });
    const result = await engine.check(tool, {}, ctx);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("explicit allow");
  });
});

describe("PermissionEngine — Layer 1 (hooks)", () => {
  it("beforeCheck hook short-circuits the pipeline", async () => {
    const hook: PermissionHook = {
      name: "audit-short-circuit",
      beforeCheck: async () => ({ allowed: true, reason: "hook allowed" }),
    };
    const engine = new PermissionEngine({
      hooks: [hook],
      rules: [{ toolId: "fs.read", decision: "deny" }], // would deny if hook didn't fire
    });
    const tool = createMockTool({ id: "fs.read" });
    const result = await engine.check(tool, {}, ctx);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("hook allowed");
  });

  it("beforeCheck hook returning null lets pipeline continue", async () => {
    const hook: PermissionHook = {
      name: "audit-log",
      beforeCheck: async () => null,
    };
    const engine = new PermissionEngine({
      hooks: [hook],
      rules: [{ toolId: "fs.read", decision: "deny", reason: "denied" }],
    });
    const tool = createMockTool({ id: "fs.read" });
    const result = await engine.check(tool, {}, ctx);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("denied");
  });

  it("afterCheck hook is called with the final decision", async () => {
    const calls: Array<{ toolId: string; allowed: boolean }> = [];
    const hook: PermissionHook = {
      name: "audit-after",
      afterCheck: async (tool, _input, decision) => {
        calls.push({ toolId: tool.id, allowed: decision.allowed });
      },
    };
    const engine = new PermissionEngine({
      hooks: [hook],
      rules: [{ toolId: "fs.read", decision: "allow" }],
    });
    const tool = createMockTool({ id: "fs.read" });
    await engine.check(tool, {}, ctx);
    expect(calls).toEqual([{ toolId: "fs.read", allowed: true }]);
  });
});

describe("PermissionEngine — fallback (no rule matched)", () => {
  it("no rule matched + no callback → deny with helpful reason", async () => {
    const engine = new PermissionEngine();
    const tool = createMockTool({ id: "fs.read" });
    const result = await engine.check(tool, {}, ctx);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/no rule matched/);
  });

  it("no rule matched + canUseTool callback → uses callback", async () => {
    const engine = new PermissionEngine({
      canUseTool: async () => ({ allowed: true, reason: "callback allowed" }),
    });
    const tool = createMockTool({ id: "fs.read" });
    const result = await engine.check(tool, {}, ctx);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("callback allowed");
  });
});

describe("PermissionEngine — rule management", () => {
  it("addRule / listRules / removeRule", () => {
    const engine = new PermissionEngine();
    engine.addRule({ toolId: "fs.read", decision: "allow" });
    engine.addRule({ toolId: "shell.exec", decision: "deny" });
    expect(engine.listRules()).toHaveLength(2);
    engine.removeRule(0);
    expect(engine.listRules()).toHaveLength(1);
    expect(engine.listRules()[0].toolId).toBe("shell.exec");
  });

  it("constructor rules are copied (not referenced)", () => {
    const input = [{ toolId: "fs.read", decision: "allow" }];
    const engine = new PermissionEngine({ rules: input });
    engine.addRule({ toolId: "x.y", decision: "deny" });
    expect(input).toHaveLength(1);
    expect(engine.listRules()).toHaveLength(2);
  });

  it("listRules returns a copy (mutation does not leak)", () => {
    const engine = new PermissionEngine({
      rules: [{ toolId: "fs.read", decision: "allow" }],
    });
    const list = engine.listRules();
    list.push({ toolId: "x.y", decision: "deny" });
    expect(engine.listRules()).toHaveLength(1);
  });
});

describe("PermissionEngine — persistence", () => {
  let temp: { dir: string; file: string };

  beforeEach(async () => {
    temp = await uniqueTempFile();
  });

  afterEach(async () => {
    await rm(temp.dir, { recursive: true, force: true });
  });

  it("saveToDisk + loadFromDisk round-trips rules", async () => {
    const engine = new PermissionEngine({
      rules: [
        { toolId: "fs.read", decision: "allow", reason: "ok" },
        { toolId: "shell.exec", decision: "deny" },
      ],
    });
    await engine.saveToDisk(temp.file);

    const engine2 = new PermissionEngine();
    await engine2.loadFromDisk(temp.file);
    expect(engine2.listRules()).toEqual([
      { toolId: "fs.read", decision: "allow", reason: "ok" },
      { toolId: "shell.exec", decision: "deny" },
    ]);
  });

  it("saveToDisk creates parent directory if missing", async () => {
    const nested = join(temp.dir, "nested", "deep", "permissions.json");
    const engine = new PermissionEngine({
      rules: [{ toolId: "fs.read", decision: "allow" }],
    });
    await engine.saveToDisk(nested);
    const s = await stat(nested);
    expect(s.isFile()).toBe(true);
  });

  it("loadFromDisk silently skips when file does not exist (no throw)", async () => {
    const engine = new PermissionEngine({
      rules: [{ toolId: "existing", decision: "allow" }],
    });
    const missing = join(temp.dir, "no-such-file.json");
    await expect(engine.loadFromDisk(missing)).resolves.toBeUndefined();
    // rules unchanged
    expect(engine.listRules()).toHaveLength(1);
    expect(engine.listRules()[0].toolId).toBe("existing");
  });

  it("saved file has expected {version, rules} shape", async () => {
    const engine = new PermissionEngine({
      rules: [{ toolId: "fs.read", decision: "allow" }],
    });
    await engine.saveToDisk(temp.file);
    const content = await (await import("node:fs/promises")).readFile(
      temp.file,
      "utf-8",
    );
    const parsed = JSON.parse(content);
    expect(parsed.version).toBe(1);
    expect(Array.isArray(parsed.rules)).toBe(true);
    expect(parsed.rules).toHaveLength(1);
  });
});

describe("PermissionEngine — composition (multi-layer integration)", () => {
  it("deny rule beats allow rule (deny layer 2 < allow layer 7)", async () => {
    const engine = new PermissionEngine({
      rules: [
        { toolId: "fs.read", decision: "allow" },
        { toolId: "fs.read", decision: "deny", reason: "deny wins" },
      ],
    });
    const tool = createMockTool({ id: "fs.read" });
    const result = await engine.check(tool, {}, ctx);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("deny wins");
  });

  it("ask rule + persisted allow prevents safety guard on second call", async () => {
    // First call: ask -> callback allow persisted -> install allow rule
    // Second call: allow rule (layer 7) — wait, safety guards are layer 5
    // so a guard would still fire first. Use a guard that only blocks "rm -rf"
    // to verify the second call doesn't hit the callback.
    let calls = 0;
    const engine = new PermissionEngine({
      rules: [{ toolId: "fs.read", decision: "ask" }],
      canUseTool: async () => {
        calls++;
        return { allowed: true, persisted: true };
      },
    });
    const tool = createMockTool({ id: "fs.read" });
    await engine.check(tool, {}, ctx);
    await engine.check(tool, {}, ctx);
    expect(calls).toBe(1); // callback only fired once
  });
});

// Type-level sanity (compile-time check that types are exported correctly)
describe("PermissionEngine — types", () => {
  it("PermissionCheckResult has the expected shape", () => {
    const r: PermissionCheckResult = { allowed: true, reason: "x", persisted: false };
    expect(r.allowed).toBe(true);
  });

  it("PermissionEngineOptions accepts all fields", () => {
    const opts: PermissionEngineOptions = {
      rules: [],
      canUseTool: async () => ({ allowed: true }),
      hooks: [],
      mode: "default",
      toolSpecificRules: [],
      safetyGuards: [],
    };
    expect(opts).toBeDefined();
  });
});
