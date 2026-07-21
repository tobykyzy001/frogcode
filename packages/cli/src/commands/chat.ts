import type { ActHandler } from "@frogcode/core";
import { Agent, createAgentConfig } from "@frogcode/core";
import type { StepRecord } from "@frogcode/core";
import {
  AnthropicProvider,
  OpenAIProvider,
  createLLMHandlers,
} from "@frogcode/llm";
import type { ChatRequest, LLMProvider, TokenUsage } from "@frogcode/llm";
import {
  ForkSandbox,
  PermissionEngine,
  ToolPipeline,
  ToolRegistry,
  builtinTools,
  createToolActHandler,
} from "@frogcode/tools";
import type { Command } from "commander";
import { formatError } from "../errors/format-error.js";

// ANSI escape codes for tool call visualization (no chalk dep)
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

/** Commander.js collector function for repeatable `--tool` options. */
export function collectToolNames(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const DEFAULT_PROVIDER = "openai";
const DEFAULT_MODEL = "gpt-4o-mini";

export interface ChatOptions {
  provider?: string;
  model?: string;
  stream?: boolean;
  baseUrl?: string;
  /** List of tool names to enable (e.g. "fs.read", "fs", "shell.exec"). Repeatable. */
  tool?: string[];
  /** Disable all tools regardless of --tool flags. */
  noTool?: boolean;
  /** Override default tool timeout in milliseconds (default: 60000). */
  toolTimeout?: number;
}

export function resolveProvider(options: ChatOptions): string {
  return options.provider || process.env.FROGCODE_PROVIDER || DEFAULT_PROVIDER;
}

export function resolveModel(options: ChatOptions): string {
  return options.model || process.env.FROGCODE_MODEL || DEFAULT_MODEL;
}

export function resolveBaseUrl(options: ChatOptions): string | undefined {
  return options.baseUrl || process.env.FROGCODE_BASE_URL;
}

export function apiKeyEnvVar(provider: string): string {
  return provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
}

export function createProvider(
  provider: string,
  apiKey: string,
  model: string,
  baseUrl?: string,
): LLMProvider {
  if (provider === "anthropic") {
    return new AnthropicProvider(
      baseUrl ? { apiKey, model, baseURL: baseUrl } : { apiKey, model },
    );
  }
  return new OpenAIProvider(
    baseUrl ? { apiKey, model, baseURL: baseUrl } : { apiKey, model },
  );
}

export function extractOutput(steps: StepRecord[]): unknown {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.type === "observe" || step.type === "reason") {
      return step.output;
    }
  }
  return undefined;
}

export function formatOutput(output: unknown): string | undefined {
  if (output === undefined || output === null) {
    return undefined;
  }
  if (typeof output === "string") {
    return output;
  }
  if (typeof output === "object" && "content" in output) {
    const content = output.content;
    if (typeof content === "string") {
      return content;
    }
  }
  return JSON.stringify(output);
}

// ─── Tool Pipeline ────────────────────────────────────────────────

export interface ToolCallLogEntry {
  name: string;
  success: boolean;
  error?: string;
}

export interface ToolPipelineResult {
  registry?: ToolRegistry;
  actHandler?: ActHandler;
  pipeline?: ToolPipeline;
  log: ToolCallLogEntry[];
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Build the tool execution pipeline based on `--tool` / `--no-tool` flags.
 *
 * Extracted for testability — returns structured result with optional
 * registry, act handler, pipeline, and execution log.
 */
export function buildToolPipeline(options: ChatOptions): ToolPipelineResult {
  const log: ToolCallLogEntry[] = [];

  // No tools if --no-tool or no --tool flags
  if (options.noTool || !options.tool || options.tool.length === 0) {
    return { log };
  }

  const registry = new ToolRegistry();
  const timeoutMs = options.toolTimeout ?? 60000;

  for (const name of options.tool) {
    // Match by exact id (fs.read) or by prefix (fs → fs.read, fs.write, fs.glob)
    // Also handle hyphenated prefixes (shell-exec → shell.exec)
    const normalizedPrefix = name.replace(/-/g, ".");
    const matched = builtinTools.filter(
      (t) =>
        t.id === name ||
        t.id.startsWith(`${name}.`) ||
        t.id.startsWith(`${normalizedPrefix}.`),
    );
    if (matched.length === 0) {
      process.stderr.write(`Warning: unknown tool "${name}", ignoring\n`);
      continue;
    }
    for (const tool of matched) {
      if (!registry.has(tool.id)) {
        registry.register(tool);
      }
    }
  }

  if (registry.size === 0) {
    process.stderr.write(
      "Warning: no valid tools registered, tools disabled\n",
    );
    return { log };
  }

  const permission = new PermissionEngine({
    mode: "default",
    canUseTool: async (_toolId, _input, _ctx) => {
      // For CLI mode, auto-approve all tools (the user explicitly requested them via --tool).
      // Individual tool permission rules (e.g. fs.read workspace-only) are handled by
      // the PermissionEngine's built-in rule layers (layers 2-5).
      return { allowed: true };
    },
  });

  const sandbox = new ForkSandbox({
    timeoutMs,
    maxMemoryMB: 512,
  });

  const pipeline = new ToolPipeline({
    registry,
    permission,
    sandbox,
    hooks: {
      onToolStart: (call) => {
        process.stdout.write(
          `${CYAN}[tool: ${call.name}]${RESET} ${DIM}calling...${RESET}\n`,
        );
      },
      onToolEnd: (call, result) => {
        if (result.success) {
          const outputSize = JSON.stringify(result.output ?? "").length;
          process.stdout.write(
            `${GREEN}[tool: ${call.name}]${RESET} ${GREEN}result: ${formatBytes(outputSize)}${RESET}\n`,
          );
          log.push({ name: call.name, success: true });
        } else {
          const errorMsg = result.error?.message ?? "unknown error";
          process.stdout.write(
            `${RED}[tool: ${call.name}]${RESET} ${RED}error: ${errorMsg}${RESET}\n`,
          );
          log.push({ name: call.name, success: false, error: errorMsg });
        }
      },
    },
  });

  const actHandler = createToolActHandler(pipeline);
  return { registry, actHandler, pipeline, log };
}

function printToolStats(log: ToolCallLogEntry[]): void {
  const stats = new Map<string, { success: number; error: number }>();
  for (const entry of log) {
    const s = stats.get(entry.name) ?? { success: 0, error: 0 };
    if (entry.success) s.success++;
    else s.error++;
    stats.set(entry.name, s);
  }

  process.stdout.write(`\n${DIM}${"─".repeat(28)}${RESET}\n`);
  process.stdout.write(`${BOLD}Tools called: ${log.length}${RESET}\n`);
  for (const [name, s] of stats) {
    const parts: string[] = [];
    if (s.success > 0) parts.push(`${s.success} success`);
    if (s.error > 0) parts.push(`${s.error} error`);
    process.stdout.write(`  - ${name}: ${parts.join(", ")}\n`);
  }
}

export async function runWithAgent(
  provider: LLMProvider,
  model: string,
  prompt: string,
  options: ChatOptions = {},
): Promise<void> {
  const toolResult = buildToolPipeline(options);

  // Build LLM handler options — pass toolRegistry so the model knows what
  // tools are available. Uses the structural `toolRegistry` field on
  // LLMHandlersOptions (added in T15), which takes precedence over the static
  // `tools` array and converts tools dynamically via toLLMTools().
  const llmOpts: {
    model: string;
    toolRegistry?: { toLLMTools: () => unknown[] };
  } = {
    model,
  };
  const registry = toolResult.registry;
  if (registry) {
    llmOpts.toolRegistry = {
      toLLMTools: () => registry.toLLMTools(),
    };
  }
  const handlers = createLLMHandlers(provider, llmOpts);

  // Replace the default EchoActHandler with the ToolActHandler when tools are
  // enabled. Both implement ActHandler, so the assignment is type-safe.
  if (toolResult.actHandler) {
    handlers.act = toolResult.actHandler;
  }

  const agent = new Agent({
    id: "cli-chat",
    config: createAgentConfig({ name: "cli-chat" }),
    handlers,
  });
  const result = await agent.run({ prompt });
  const output = formatOutput(extractOutput(result.steps));
  if (output !== undefined) {
    process.stdout.write(`${output}\n`);
  }

  // Print tool call statistics when tools were used
  if (toolResult.log.length > 0) {
    printToolStats(toolResult.log);
  }
}

export async function runWithStreaming(
  provider: LLMProvider,
  model: string,
  prompt: string,
): Promise<void> {
  const req: ChatRequest = {
    messages: [
      {
        id: `chat-${Date.now()}`,
        role: "user",
        content: prompt,
        timestamp: Date.now(),
      },
    ],
    model,
  };

  let usage: TokenUsage | undefined;
  process.stdout.write("\n");
  for await (const chunk of provider.stream(req)) {
    if (chunk.delta?.content) {
      process.stdout.write(chunk.delta.content);
    }
    if (chunk.usage) {
      usage = chunk.usage;
    }
  }
  process.stdout.write("\n");

  process.stdout.write("────────────────────────────\n");
  if (usage) {
    process.stdout.write(
      `Tokens: ${usage.totalTokens} (prompt: ${usage.promptTokens}, completion: ${usage.completionTokens})\n`,
    );
  } else {
    process.stdout.write("Tokens: (usage unavailable)\n");
  }
}

export function registerChatCommand(program: Command): void {
  program
    .command("chat <prompt>")
    .description("Chat with an LLM (single turn)")
    .option("--provider <provider>", "openai or anthropic")
    .option("--model <model>", "model name")
    .option("--base-url <url>", "custom API base URL (OpenAI-compatible)")
    .option("--no-stream", "disable streaming")
    .option(
      "-t, --tool <name>",
      "enable a built-in tool (repeatable)",
      collectToolNames,
      [] as string[],
    )
    .option("--no-tool", "disable all tools")
    .option(
      "--tool-timeout <ms>",
      "override default tool timeout",
      (v: string) => Number.parseInt(v, 10),
      60000,
    )
    .action(async (prompt: string, options: ChatOptions) => {
      const providerName = resolveProvider(options);
      const model = resolveModel(options);
      const baseUrl = resolveBaseUrl(options);
      const envVar = apiKeyEnvVar(providerName);
      const apiKey = process.env[envVar];
      if (!apiKey) {
        process.stderr.write(`❌ 未设置 ${envVar} 环境变量\n`);
        process.exit(1);
      }
      try {
        const provider = createProvider(providerName, apiKey, model, baseUrl);
        if (options.stream === false) {
          await runWithAgent(provider, model, prompt, options);
        } else {
          await runWithStreaming(provider, model, prompt);
        }
      } catch (error) {
        process.stderr.write(`${formatError(error)}\n`);
        process.exit(1);
      }
    });
}
