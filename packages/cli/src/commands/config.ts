import type { Command } from "commander";
import { apiKeyEnvVar } from "./chat.js";

const DEFAULT_PROVIDER = "openai";
const DEFAULT_MODEL = "gpt-4o-mini";
const EVENTS_PATH = ".frogcode/events/";
const RULE = "────────────────────────";
const LABEL_WIDTH = 11;

export interface ConfigInfo {
  provider: string;
  model: string;
  apiKeyEnvVar: string;
  apiKeySet: boolean;
  baseUrl: string;
  eventsPath: string;
}

export function resolveConfig(): ConfigInfo {
  const provider = process.env.FROGCODE_PROVIDER ?? DEFAULT_PROVIDER;
  const model = process.env.FROGCODE_MODEL ?? DEFAULT_MODEL;
  const envVar = apiKeyEnvVar(provider);
  const apiKeySet =
    process.env[envVar] !== undefined && process.env[envVar] !== "";
  const baseUrl = process.env.FROGCODE_BASE_URL ?? "(default)";
  return {
    provider,
    model,
    apiKeyEnvVar: envVar,
    apiKeySet,
    baseUrl,
    eventsPath: EVENTS_PATH,
  };
}

export function formatConfig(info: ConfigInfo): string {
  const apiKeyMark = info.apiKeySet ? "✓" : "✗";
  const providerLabel = "Provider:".padEnd(LABEL_WIDTH);
  const modelLabel = "Model:".padEnd(LABEL_WIDTH);
  const apiKeyLabel = "API Key:".padEnd(LABEL_WIDTH);
  const baseUrlLabel = "Base URL:".padEnd(LABEL_WIDTH);
  const eventsLabel = "Events:".padEnd(LABEL_WIDTH);
  const lines = [
    "FrogCode Configuration",
    RULE,
    `${providerLabel}${info.provider}`,
    `${modelLabel}${info.model}`,
    `${apiKeyLabel}${apiKeyMark} (${info.apiKeyEnvVar})`,
    `${baseUrlLabel}${info.baseUrl}`,
    `${eventsLabel}${info.eventsPath}`,
    "",
  ];
  return `${lines.join("\n")}`;
}

export function registerConfigCommand(program: Command): void {
  program
    .command("config")
    .description("Show current FrogCode configuration")
    .action(() => {
      const info = resolveConfig();
      process.stdout.write(formatConfig(info));
    });
}
