import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolContext } from "../context.js";
import type { ToolDefinition } from "../definition.js";
import { matchGlob } from "./glob.js";
import type { PermissionDecision, PermissionRule } from "./rule.js";
import type {
  CanUseToolCallback,
  PermissionCheckResult,
  PermissionHook,
  PermissionMode,
  SafetyGuard,
  ToolSpecificRule,
} from "./types.js";

export interface PermissionEngineOptions {
  rules?: PermissionRule[];
  canUseTool?: CanUseToolCallback;
  hooks?: PermissionHook[];
  mode?: PermissionMode;
  toolSpecificRules?: ToolSpecificRule[];
  safetyGuards?: SafetyGuard[];
}

/**
 * Claude Code 7-layer permission pipeline.
 *
 * Decision order (short-circuits on first non-null decision):
 *   1. hooks           — pre-processing (audit log, metrics)
 *   2. deny            — explicit deny rules (highest priority among rules)
 *   3. ask             — rules that require confirmation
 *   4. tool-specific   — tool built-in rules (e.g. fs.read default allow workspace)
 *   5. safety-guards   — unbypassable guards (e.g. shell always denies `rm -rf /`)
 *   6. mode            — current mode (e.g. auto-approve-read auto-approves readonly)
 *   7. allow           — explicit allow rules
 *
 * If no layer decides: calls `canUseTool` callback, defaulting to deny.
 */
export class PermissionEngine {
  private rules: PermissionRule[];
  private readonly canUseTool?: CanUseToolCallback;
  private readonly hooks: PermissionHook[];
  private mode: PermissionMode;
  private readonly toolSpecificRules: ToolSpecificRule[];
  private readonly safetyGuards: SafetyGuard[];

  constructor(opts: PermissionEngineOptions = {}) {
    this.rules = opts.rules ? [...opts.rules] : [];
    this.canUseTool = opts.canUseTool;
    this.hooks = opts.hooks ? [...opts.hooks] : [];
    this.mode = opts.mode ?? "default";
    this.toolSpecificRules = opts.toolSpecificRules
      ? [...opts.toolSpecificRules]
      : [];
    this.safetyGuards = opts.safetyGuards ? [...opts.safetyGuards] : [];
  }

  async check(
    tool: ToolDefinition,
    input: unknown,
    ctx: ToolContext,
  ): Promise<PermissionCheckResult> {
    // Layer 1: hooks — pre-processing (audit log, metrics)
    for (const hook of this.hooks) {
      if (hook.beforeCheck) {
        const decision = await hook.beforeCheck(tool, input, ctx);
        if (decision) return decision;
      }
    }

    // Layer 2: deny — explicit deny rules (highest priority among rules)
    const denyRule = this.findRule(tool.id, "deny");
    if (denyRule) {
      const decision: PermissionCheckResult = {
        allowed: false,
        reason: denyRule.reason ?? "denied by rule",
      };
      await this.runAfterCheck(tool, input, decision, ctx);
      return decision;
    }

    // Layer 3: ask — rules that require confirmation
    const askRule = this.findRule(tool.id, "ask");
    if (askRule) {
      const decision = await this.askUser(tool, input, ctx, askRule.reason);
      await this.runAfterCheck(tool, input, decision, ctx);
      return decision;
    }

    // Layer 4: tool-specific — built-in rules per tool
    for (const rule of this.toolSpecificRules) {
      if (this.matchesToolId(rule.toolId, tool.id)) {
        const decision = rule.evaluate(input, ctx);
        if (decision) {
          await this.runAfterCheck(tool, input, decision, ctx);
          return decision;
        }
      }
    }

    // Layer 5: safety-guards — cannot be bypassed by mode/allow layers
    for (const guard of this.safetyGuards) {
      const decision = guard.evaluate(tool, input, ctx);
      if (decision) {
        await this.runAfterCheck(tool, input, decision, ctx);
        return decision;
      }
    }

    // Layer 6: mode — current mode
    const modeDecision = this.applyMode(tool);
    if (modeDecision) {
      await this.runAfterCheck(tool, input, modeDecision, ctx);
      return modeDecision;
    }

    // Layer 7: allow — explicit allow rules
    const allowRule = this.findRule(tool.id, "allow");
    if (allowRule) {
      const decision: PermissionCheckResult = {
        allowed: true,
        reason: allowRule.reason ?? "allowed by rule",
      };
      await this.runAfterCheck(tool, input, decision, ctx);
      return decision;
    }

    // No layer decided — call canUseTool callback (default deny)
    let fallback: PermissionCheckResult;
    if (this.canUseTool) {
      fallback = await this.canUseTool(tool.id, input, ctx);
    } else {
      fallback = {
        allowed: false,
        reason: "no rule matched and no callback configured",
      };
    }
    await this.runAfterCheck(tool, input, fallback, ctx);
    return fallback;
  }

  addRule(rule: PermissionRule): void {
    this.rules.push(rule);
  }

  removeRule(index: number): void {
    this.rules.splice(index, 1);
  }

  listRules(): PermissionRule[] {
    return [...this.rules];
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  async saveToDisk(path: string): Promise<void> {
    const data = {
      version: 1,
      rules: this.rules,
    };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(data, null, 2), "utf-8");
  }

  async loadFromDisk(path: string): Promise<void> {
    let content: string;
    try {
      content = await readFile(path, "utf-8");
    } catch (err) {
      // File-not-found is a benign case for `loadFromDisk` — nothing to load.
      if (
        err instanceof Error &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return;
      }
      throw err;
    }
    const data = JSON.parse(content) as { rules?: PermissionRule[] };
    if (data.rules && Array.isArray(data.rules)) {
      this.rules = data.rules;
    }
  }

  private findRule(
    toolId: string,
    decision: PermissionDecision,
  ): PermissionRule | undefined {
    return this.rules.find(
      (r) =>
        r.decision === decision &&
        this.matchesToolId(r.toolId, toolId) &&
        !this.isExpired(r),
    );
  }

  private matchesToolId(pattern: string, toolId: string): boolean {
    return matchGlob(pattern, toolId);
  }

  private isExpired(rule: PermissionRule): boolean {
    if (rule.expiresAt === undefined) return false;
    return Date.now() > rule.expiresAt;
  }

  private async askUser(
    tool: ToolDefinition,
    input: unknown,
    ctx: ToolContext,
    reason?: string,
  ): Promise<PermissionCheckResult> {
    if (this.canUseTool) {
      const decision = await this.canUseTool(tool.id, input, ctx);
      // Persisted allow decision: "don't ask again" semantics.
      // Remove the matching ask rule(s) so subsequent checks short-circuit
      // at layer 7 (allow) instead of re-entering the ask layer.
      if (decision.persisted === true && decision.allowed === true) {
        this.rules = this.rules.filter(
          (r) =>
            !(this.matchesToolId(r.toolId, tool.id) && r.decision === "ask"),
        );
        this.rules.push({
          toolId: tool.id,
          decision: "allow",
          reason: "persisted from user confirm",
        });
      }
      return decision;
    }
    return {
      allowed: false,
      reason: reason ?? "permission required but no callback configured",
    };
  }

  private applyMode(tool: ToolDefinition): PermissionCheckResult | null {
    switch (this.mode) {
      case "auto-approve-all":
        return { allowed: true, reason: "auto-approve-all mode" };
      case "deny-all":
        return { allowed: false, reason: "deny-all mode" };
      case "auto-approve-read":
        if (tool.tags.includes("readonly") || tool.tags.includes("read")) {
          return { allowed: true, reason: "auto-approve-read mode" };
        }
        return null;
      default:
        return null;
    }
  }

  private async runAfterCheck(
    tool: ToolDefinition,
    input: unknown,
    decision: PermissionCheckResult,
    ctx: ToolContext,
  ): Promise<void> {
    for (const hook of this.hooks) {
      if (hook.afterCheck) {
        await hook.afterCheck(tool, input, decision, ctx);
      }
    }
  }
}
