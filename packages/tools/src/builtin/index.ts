/**
 * Barrel for built-in tools.
 *
 * Future Wave 3 tasks (T10 shell, T11 http, T12 search) will add their own
 * `builtin*Tools` arrays here and the union `builtinTools` array will grow.
 *
 * Note on typing: `ToolDefinition<I, O>` is invariant in `I` because the
 * `execute` function uses it in a parameter position. A heterogeneous
 * array of tools with different input shapes therefore cannot be typed as
 * `ToolDefinition<unknown, unknown>[]` — the assignment would fail variance
 * checking. We use `ToolDefinition<any, any>` here, which is the standard
 * TypeScript idiom for "a registry of tools with heterogeneous input/output
 * shapes". This does NOT weaken caller safety: each tool's own `inputSchema`
 * (a Zod schema) is the source of truth for input validation at runtime.
 */
import type { ToolDefinition } from "../definition.js";
import { fsGlobTool, fsReadTool, fsTools, fsWriteTool } from "./fs.js";
import {
  DEFAULT_ALLOWED_DOMAINS,
  checkSsrf,
  httpDomainRule,
  httpRequestTool,
  httpSsrfGuard,
  isSsrfSafe,
} from "./http.js";
import { searchGlobTool, searchGrepTool } from "./search.js";
import { shellRiskRule, shellTools } from "./shell.js";

export { fsReadTool, fsWriteTool, fsGlobTool, fsTools };
export {
  httpRequestTool,
  httpSsrfGuard,
  httpDomainRule,
  checkSsrf,
  isSsrfSafe,
  DEFAULT_ALLOWED_DOMAINS,
};
export {
  shellExecTool,
  shellTools,
  evaluateRisk,
  shellRiskRule,
} from "./shell.js";
export type { ShellRisk } from "./shell.js";
export {
  searchGrepTool,
  searchGlobTool,
  __grepWithJsForTests,
} from "./search.js";

// `ToolDefinition<I, O>` is invariant in `I` because the `execute` function
// uses it in a parameter position. A heterogeneous array of tools with
// different input shapes therefore cannot be typed as
// `ToolDefinition<unknown, unknown>[]` — the assignment fails variance
// checking. We use `ToolDefinition<any, any>` here, which is the standard
// TypeScript idiom for "a registry of tools with heterogeneous input/output
// shapes". This does NOT weaken caller safety: each tool's own `inputSchema`
// (a Zod schema) is the source of truth for input validation at runtime.
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool registry requires any-typed entries; runtime validation is provided by each tool's Zod inputSchema
type AnyToolDefinition = ToolDefinition<any, any>;

export const builtinFsTools: readonly AnyToolDefinition[] = [
  fsReadTool,
  fsWriteTool,
  fsGlobTool,
];

export const builtinHttpTools: readonly AnyToolDefinition[] = [httpRequestTool];

export const builtinShellTools: readonly AnyToolDefinition[] = [...shellTools];

export const builtinSearchTools: readonly AnyToolDefinition[] = [
  searchGrepTool,
  searchGlobTool,
];

/** SSRF safety guards shipped with the builtin tools. */
export const builtinHttpSafetyGuards = [httpSsrfGuard];

/** Tool-specific permission rules shipped with the builtin tools. */
export const builtinHttpPermissionRules = [httpDomainRule];

/** Shell risk-classification rule shipped with the builtin tools. */
export const builtinShellPermissionRules = [shellRiskRule];

/**
 * All built-in tools. Updated as new builtin tool groups land.
 */
export const builtinTools: readonly AnyToolDefinition[] = [
  ...builtinFsTools,
  ...builtinHttpTools,
  ...builtinShellTools,
  ...builtinSearchTools,
];
