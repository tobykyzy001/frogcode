export const TOOLS_VERSION = "0.1.0";
export type { ToolDefinition, LLMToolDefinition } from "./definition.js";
export { createTool, toLLMTool } from "./definition.js";
export { zodToJsonSchema } from "./zod-to-json-schema.js";
export type { JsonSchema } from "./zod-to-json-schema.js";
export type { ToolContext, ToolLogger } from "./context.js";
export type { PermissionRule, PermissionDecision } from "./permission/rule.js";
export { matchGlob } from "./permission/glob.js";
export { PermissionEngine } from "./permission/engine.js";
export type { PermissionEngineOptions } from "./permission/engine.js";
export type {
  PermissionMode,
  PermissionHook,
  CanUseToolCallback,
  ToolSpecificRule,
  SafetyGuard,
  PermissionCheckResult,
} from "./permission/types.js";
export { ToolRegistry } from "./registry.js";
export { ToolAlreadyRegisteredError, ToolNotFoundError } from "./registry.js";

// Built-in tools (T9 fs, T11 http, ...) — see ./builtin/index.js for the
// authoritative barrel. Only http-related symbols are re-exported here as
// part of T11; other groups add their own exports when they land.
export {
  httpRequestTool,
  httpSsrfGuard,
  httpDomainRule,
  checkSsrf,
  isSsrfSafe,
  DEFAULT_ALLOWED_DOMAINS,
} from "./builtin/index.js";

// Testing helpers
export * from "./testing/index.js";
export type {
  ToolActResult,
  ToolResultEntry,
  ToolResultError,
  ToolCallStepInput,
  ToolResultStepOutput,
} from "./bridge.js";

// Sandbox (child_process.fork-based tool isolation)
export { ForkSandbox } from "./sandbox/fork-sandbox.js";
export type { ForkSandboxOptions } from "./sandbox/fork-sandbox.js";
export type { SandboxResult, SandboxErrorInfo } from "./sandbox/types.js";
export {
  SandboxError,
  ToolTimeoutError,
  ToolMemoryError,
  ToolCrashError,
} from "./sandbox/types.js";

// Pipeline (orchestrates registry + permission + sandbox into one call flow)
export { ToolPipeline } from "./pipeline.js";
export type {
  ToolCall,
  ToolHooks,
  ToolPipelineOptions,
  PermissionChecker,
  SandboxRunner,
} from "./pipeline.js";
export {
  ToolError,
  PermissionDeniedError,
  ValidationError,
  OutputValidationError,
} from "./pipeline.js";

// Built-in: http tools (isSsrfSafe also re-exported via ./builtin/index.js above)
// (Consolidated — see http block at top of file)

// Act handler (PRAO integration — bridges Act phase with ToolPipeline)
export { createToolActHandler } from "./act-handler.js";
export type { ToolActionResult, ToolDecision } from "./act-handler.js";

// Built-in tools
export {
  fsReadTool,
  fsWriteTool,
  fsGlobTool,
  fsTools,
  builtinFsTools,
  builtinTools,
} from "./builtin/index.js";

// Built-in: shell tools
export { shellExecTool, evaluateRisk, shellRiskRule } from "./builtin/shell.js";
export type { ShellRisk } from "./builtin/shell.js";

// Built-in: search tools (search.grep, search.glob)
export {
  searchGrepTool,
  searchGlobTool,
  builtinSearchTools,
  __grepWithJsForTests,
} from "./builtin/index.js";
