import { Agent, createAgentConfig } from "@frogcode/core";
import type { StepRecord } from "@frogcode/core";
import {
  AnthropicProvider,
  OpenAIProvider,
  createLLMHandlers,
} from "@frogcode/llm";
import type { ChatRequest, LLMProvider, TokenUsage } from "@frogcode/llm";
import type { Command } from "commander";
import { formatError } from "../errors/format-error.js";

const DEFAULT_PROVIDER = "openai";
const DEFAULT_MODEL = "gpt-4o-mini";

export interface ChatOptions {
  provider?: string;
  model?: string;
  stream?: boolean;
  baseUrl?: string;
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

export async function runWithAgent(
  provider: LLMProvider,
  model: string,
  prompt: string,
): Promise<void> {
  const handlers = createLLMHandlers(provider, { model });
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
          await runWithAgent(provider, model, prompt);
        } else {
          await runWithStreaming(provider, model, prompt);
        }
      } catch (error) {
        process.stderr.write(`${formatError(error)}\n`);
        process.exit(1);
      }
    });
}
