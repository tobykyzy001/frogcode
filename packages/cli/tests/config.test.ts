import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatConfig,
  registerConfigCommand,
  resolveConfig,
} from "../src/commands/config.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.FROGCODE_PROVIDER;
  delete process.env.FROGCODE_MODEL;
  delete process.env.FROGCODE_BASE_URL;
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("resolveConfig", () => {
  it("defaults provider to openai when no env is set", () => {
    expect(resolveConfig().provider).toBe("openai");
  });

  it("uses FROGCODE_PROVIDER env when set", () => {
    process.env.FROGCODE_PROVIDER = "anthropic";
    expect(resolveConfig().provider).toBe("anthropic");
  });

  it("uses FROGCODE_MODEL env when set", () => {
    process.env.FROGCODE_MODEL = "claude-3-opus";
    expect(resolveConfig().model).toBe("claude-3-opus");
  });

  it("defaults model to gpt-4o-mini when no env is set", () => {
    expect(resolveConfig().model).toBe("gpt-4o-mini");
  });

  it("returns OPENAI_API_KEY as the env var for openai", () => {
    expect(resolveConfig().apiKeyEnvVar).toBe("OPENAI_API_KEY");
  });

  it("returns ANTHROPIC_API_KEY as the env var for anthropic", () => {
    process.env.FROGCODE_PROVIDER = "anthropic";
    expect(resolveConfig().apiKeyEnvVar).toBe("ANTHROPIC_API_KEY");
  });

  it("returns apiKeySet=true when the env var has a value", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    expect(resolveConfig().apiKeySet).toBe(true);
  });

  it("returns apiKeySet=false when the env var is missing", () => {
    expect(resolveConfig().apiKeySet).toBe(false);
  });

  it("returns apiKeySet=false when the env var is empty string", () => {
    process.env.OPENAI_API_KEY = "";
    expect(resolveConfig().apiKeySet).toBe(false);
  });

  it("returns the default events path", () => {
    expect(resolveConfig().eventsPath).toBe(".frogcode/events/");
  });
});

describe("formatConfig", () => {
  const baseInfo = {
    provider: "openai",
    model: "gpt-4o-mini",
    apiKeyEnvVar: "OPENAI_API_KEY",
    baseUrl: "(default)",
    eventsPath: ".frogcode/events/",
  } as const;

  it("contains the FrogCode Configuration header", () => {
    const output = formatConfig({ ...baseInfo, apiKeySet: true });
    expect(output).toContain("FrogCode Configuration");
  });

  it("contains the provider name", () => {
    const output = formatConfig({
      ...baseInfo,
      provider: "openai",
      apiKeySet: true,
    });
    expect(output).toContain("openai");
  });

  it("contains the model name", () => {
    const output = formatConfig({
      ...baseInfo,
      model: "gpt-4o-mini",
      apiKeySet: true,
    });
    expect(output).toContain("gpt-4o-mini");
  });

  it("contains ✓ when the API key is set", () => {
    const output = formatConfig({ ...baseInfo, apiKeySet: true });
    expect(output).toContain("✓");
  });

  it("contains ✗ when the API key is not set", () => {
    const output = formatConfig({ ...baseInfo, apiKeySet: false });
    expect(output).toContain("✗");
  });

  it("contains the events path", () => {
    const output = formatConfig({ ...baseInfo, apiKeySet: true });
    expect(output).toContain(".frogcode/events/");
  });

  it("contains the API key env var name", () => {
    const output = formatConfig({ ...baseInfo, apiKeySet: true });
    expect(output).toContain("OPENAI_API_KEY");
  });

  it("shows (default) when no base URL is configured", () => {
    const output = formatConfig({ ...baseInfo, apiKeySet: true });
    expect(output).toContain("Base URL:");
    expect(output).toContain("(default)");
  });

  it("shows the configured base URL when set", () => {
    const output = formatConfig({
      ...baseInfo,
      apiKeySet: true,
      baseUrl: "http://your-gateway/v1",
    });
    expect(output).toContain("Base URL:");
    expect(output).toContain("http://your-gateway/v1");
  });
});

describe("resolveConfig base URL", () => {
  it("defaults to (default) when FROGCODE_BASE_URL not set", () => {
    delete process.env.FROGCODE_BASE_URL;
    expect(resolveConfig().baseUrl).toBe("(default)");
  });

  it("uses FROGCODE_BASE_URL env when set", () => {
    process.env.FROGCODE_BASE_URL = "http://gateway/v1";
    expect(resolveConfig().baseUrl).toBe("http://gateway/v1");
  });
});

describe("registerConfigCommand", () => {
  it("writes the formatted config to stdout when invoked", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    const { Command } = await import("commander");
    const program = new Command();
    registerConfigCommand(program);
    await program.parseAsync(["node", "frogcode", "config"]);

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const written = stdoutSpy.mock.calls[0]?.[0];
    expect(typeof written).toBe("string");
    expect(written as string).toContain("FrogCode Configuration");
    expect(written as string).toContain("openai");
    expect(written as string).toContain("gpt-4o-mini");
    expect(written as string).toContain("✓");
    expect(written as string).toContain(".frogcode/events/");
    expect(written as string).toContain("Base URL:");
  });
});
