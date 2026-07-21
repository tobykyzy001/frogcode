import type { ToolContext } from "../context.js";
import type { ToolDefinition } from "../definition.js";

/**
 * Engine check result. Note: `PermissionDecision` in `rule.ts` is the rule's
 * `"allow" | "deny" | "ask"` union (kept unchanged for backwards compat);
 * the engine's `check()` returns this richer shape instead.
 */
export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
  /** When true and allowed, the engine persists an allow rule for this tool. */
  persisted?: boolean;
}

/**
 * Engine modes that govern what happens when no explicit rule matches.
 *
 * - `default`            — ask via callback on uncertain; deny on no match
 * - `auto-approve-read`  — auto-approve readonly-tagged tools
 * - `auto-approve-all`   — auto-approve everything (CI mode)
 * - `deny-all`           — deny everything (lockdown)
 */
export type PermissionMode =
  | "default"
  | "auto-approve-read"
  | "auto-approve-all"
  | "deny-all";

/**
 * Hook executed around the permission check. A `beforeCheck` hook may
 * short-circuit the pipeline by returning a non-null decision (e.g. for
 * audit logging, metrics, or to force an allow/deny).
 */
export interface PermissionHook {
  name: string;
  beforeCheck?: (
    tool: ToolDefinition,
    input: unknown,
    ctx: ToolContext,
  ) => Promise<PermissionCheckResult | null>;
  afterCheck?: (
    tool: ToolDefinition,
    input: unknown,
    decision: PermissionCheckResult,
    ctx: ToolContext,
  ) => Promise<void>;
}

/** Programmatic callback invoked when no rule matches (and for `ask` rules). */
export type CanUseToolCallback = (
  toolId: string,
  input: unknown,
  ctx: ToolContext,
) => Promise<PermissionCheckResult>;

/**
 * Tool-specific rule evaluator — implemented by individual tools (T9-T12).
 * Returning `null` means "no opinion" and the pipeline continues.
 */
export interface ToolSpecificRule {
  /** Tool id or glob pattern (e.g. `fs.read` or `fs.*`). */
  toolId: string;
  evaluate: (input: unknown, ctx: ToolContext) => PermissionCheckResult | null;
}

/**
 * Safety guard — cannot be bypassed by mode or allow rules (layers 6 & 7).
 * Returning `null` means "no opinion" and the pipeline continues.
 */
export interface SafetyGuard {
  name: string;
  evaluate: (
    tool: ToolDefinition,
    input: unknown,
    ctx: ToolContext,
  ) => PermissionCheckResult | null;
}
