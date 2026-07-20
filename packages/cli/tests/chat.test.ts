import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@frogcode/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@frogcode/llm")>();
  const { createMockHandlers } = await import("@frogcode/core");
  const createMockProvider = () => ({
    chat: vi.fn(),
    embed: vi.fn(),
    stream: async function* (req: {
      messages: Array<{ content: string }>;
    }) {
      const content = req.messages[0]?.content ?? "";
      yield { delta: { content: `${content}\n` } };
    },
  });
  return {
    ...actual,
    OpenAIProvider: vi.fn().mockImplementation(() => createMockProvider()),
    AnthropicProvider: vi.fn().mockImplementation(() => createMockProvider()),
    createLLMHandlers: vi.fn().mockImplementation(() => createMockHandlers()),
  };
});

import type { ChatChunk, LLMProvider } from "@frogcode/llm";
import { AnthropicProvider, OpenAIProvider } from "@frogcode/llm";
import {
  apiKeyEnvVar,
  createProvider,
  resolveBaseUrl,
  resolveModel,
  resolveProvider,
  runWithStreaming,
} from "../src/commands/chat.js";
import { createProgram } from "../src/index.js";

describe("chat command", () => {
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "frogcode-cli-test-"));
    process.chdir(tempDir);
    process.env = { ...originalEnv };
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.FROGCODE_PROVIDER;
    delete process.env.FROGCODE_MODEL;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  describe("resolveProvider", () => {
    it("defaults to openai", () => {
      expect(resolveProvider({})).toBe("openai");
    });

    it("uses --provider option", () => {
      expect(resolveProvider({ provider: "anthropic" })).toBe("anthropic");
    });

    it("falls back to FROGCODE_PROVIDER env", () => {
      process.env.FROGCODE_PROVIDER = "anthropic";
      expect(resolveProvider({})).toBe("anthropic");
    });

    it("prefers option over env", () => {
      process.env.FROGCODE_PROVIDER = "anthropic";
      expect(resolveProvider({ provider: "openai" })).toBe("openai");
    });
  });

  describe("resolveModel", () => {
    it("defaults to gpt-4o-mini", () => {
      expect(resolveModel({})).toBe("gpt-4o-mini");
    });

    it("uses --model option", () => {
      expect(resolveModel({ model: "gpt-4" })).toBe("gpt-4");
    });

    it("falls back to FROGCODE_MODEL env", () => {
      process.env.FROGCODE_MODEL = "claude-3-opus";
      expect(resolveModel({})).toBe("claude-3-opus");
    });

    it("prefers option over env", () => {
      process.env.FROGCODE_MODEL = "claude-3-opus";
      expect(resolveModel({ model: "gpt-4" })).toBe("gpt-4");
    });
  });

  describe("apiKeyEnvVar", () => {
    it("returns OPENAI_API_KEY for openai", () => {
      expect(apiKeyEnvVar("openai")).toBe("OPENAI_API_KEY");
    });

    it("returns ANTHROPIC_API_KEY for anthropic", () => {
      expect(apiKeyEnvVar("anthropic")).toBe("ANTHROPIC_API_KEY");
    });

    it("defaults to OPENAI_API_KEY for unknown provider", () => {
      expect(apiKeyEnvVar("unknown")).toBe("OPENAI_API_KEY");
    });
  });

  describe("command parsing via createProgram()", () => {
    // Command parsing tests use --no-stream to exercise the agent.run() path,
    // which is fully mocked via createLLMHandlers -> createMockHandlers.
    // Streaming behavior is covered separately in the "streaming mode" block.

    it("parses chat 'hello' with default provider/model", async () => {
      process.env.OPENAI_API_KEY = "test-key";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      const program = createProgram();
      await program.parseAsync([
        "node",
        "frogcode",
        "chat",
        "hello",
        "--no-stream",
      ]);

      expect(OpenAIProvider).toHaveBeenCalledWith({
        apiKey: "test-key",
        model: "gpt-4o-mini",
      });
      expect(AnthropicProvider).not.toHaveBeenCalled();
      expect(stdoutSpy).toHaveBeenCalledWith("hello\n");
    });

    it("passes --provider anthropic and --model gpt-4", async () => {
      process.env.ANTHROPIC_API_KEY = "claude-key";
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      const program = createProgram();
      await program.parseAsync([
        "node",
        "frogcode",
        "chat",
        "hello",
        "--provider",
        "anthropic",
        "--model",
        "gpt-4",
        "--no-stream",
      ]);

      expect(AnthropicProvider).toHaveBeenCalledWith({
        apiKey: "claude-key",
        model: "gpt-4",
      });
      expect(OpenAIProvider).not.toHaveBeenCalled();
    });

    it("respects FROGCODE_PROVIDER env when no --provider flag", async () => {
      process.env.ANTHROPIC_API_KEY = "claude-key";
      process.env.FROGCODE_PROVIDER = "anthropic";
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      const program = createProgram();
      await program.parseAsync([
        "node",
        "frogcode",
        "chat",
        "hi",
        "--no-stream",
      ]);

      expect(AnthropicProvider).toHaveBeenCalledWith({
        apiKey: "claude-key",
        model: "gpt-4o-mini",
      });
    });

    it("respects FROGCODE_MODEL env when no --model flag", async () => {
      process.env.OPENAI_API_KEY = "test-key";
      process.env.FROGCODE_MODEL = "gpt-4-turbo";
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      const program = createProgram();
      await program.parseAsync([
        "node",
        "frogcode",
        "chat",
        "hi",
        "--no-stream",
      ]);

      expect(OpenAIProvider).toHaveBeenCalledWith({
        apiKey: "test-key",
        model: "gpt-4-turbo",
      });
    });
  });

  describe("API key missing", () => {
    const exitThrow = (code?: number): never => {
      throw new Error(`EXIT:${code ?? 0}`);
    };

    it("errors with OPENAI_API_KEY message when not set", async () => {
      delete process.env.OPENAI_API_KEY;
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(exitThrow);
      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);

      const program = createProgram();
      await expect(
        program.parseAsync(["node", "frogcode", "chat", "hello"]),
      ).rejects.toThrow("EXIT:1");

      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("OPENAI_API_KEY"),
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("errors with ANTHROPIC_API_KEY message for --provider anthropic", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(exitThrow);
      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);

      const program = createProgram();
      await expect(
        program.parseAsync([
          "node",
          "frogcode",
          "chat",
          "hello",
          "--provider",
          "anthropic",
        ]),
      ).rejects.toThrow("EXIT:1");

      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("ANTHROPIC_API_KEY"),
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe("streaming mode", () => {
    function createMockStreamProvider(chunks: ChatChunk[]): LLMProvider {
      return {
        chat: vi.fn(),
        embed: vi.fn(),
        stream: async function* () {
          for (const chunk of chunks) yield chunk;
        },
      };
    }

    it("runWithStreaming writes chunks to stdout in real time", async () => {
      const chunks: ChatChunk[] = [
        { delta: { content: "Hello" } },
        { delta: { content: ", " } },
        { delta: { content: "world!" } },
      ];
      const mockProvider = createMockStreamProvider(chunks);

      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      await runWithStreaming(mockProvider, "gpt-4", "Hello");

      expect(stdoutSpy).toHaveBeenCalledWith("\n");
      expect(stdoutSpy).toHaveBeenCalledWith("Hello");
      expect(stdoutSpy).toHaveBeenCalledWith(", ");
      expect(stdoutSpy).toHaveBeenCalledWith("world!");
      expect(stdoutSpy).toHaveBeenCalledWith("\n");
      expect(stdoutSpy).toHaveBeenCalledWith("────────────────────────────\n");
    });

    it("extracts usage from the last chunk", async () => {
      const chunks: ChatChunk[] = [
        {
          delta: { content: "Hi" },
          usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 },
        },
        {
          delta: { content: " there" },
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        },
      ];
      const mockProvider = createMockStreamProvider(chunks);

      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      await runWithStreaming(mockProvider, "gpt-4", "Hi");

      expect(stdoutSpy).toHaveBeenCalledWith(
        "Tokens: 150 (prompt: 100, completion: 50)\n",
      );
    });

    it("displays '(usage unavailable)' when no chunk carries usage", async () => {
      const chunks: ChatChunk[] = [
        { delta: { content: "Hi" } },
        { delta: { content: " there" } },
      ];
      const mockProvider = createMockStreamProvider(chunks);

      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      await runWithStreaming(mockProvider, "gpt-4", "Hi");

      expect(stdoutSpy).toHaveBeenCalledWith("Tokens: (usage unavailable)\n");
    });

    it("--no-stream flag triggers agent.run() path, not streaming", async () => {
      process.env.OPENAI_API_KEY = "test-key";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      const program = createProgram();
      await program.parseAsync([
        "node",
        "frogcode",
        "chat",
        "hello",
        "--no-stream",
      ]);

      expect(stdoutSpy).toHaveBeenCalledWith("hello\n");
      expect(stdoutSpy).not.toHaveBeenCalledWith(
        "────────────────────────────\n",
      );
      expect(stdoutSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("Tokens:"),
      );
    });
  });

  describe("base URL", () => {
    it("resolveBaseUrl returns undefined when neither option nor env set", () => {
      delete process.env.FROGCODE_BASE_URL;
      expect(resolveBaseUrl({})).toBeUndefined();
    });

    it("resolveBaseUrl uses --base-url option", () => {
      delete process.env.FROGCODE_BASE_URL;
      expect(resolveBaseUrl({ baseUrl: "http://localhost:8080/v1" })).toBe(
        "http://localhost:8080/v1",
      );
    });

    it("resolveBaseUrl falls back to FROGCODE_BASE_URL env", () => {
      process.env.FROGCODE_BASE_URL = "http://env-host/v1";
      expect(resolveBaseUrl({})).toBe("http://env-host/v1");
    });

    it("resolveBaseUrl prefers option over env", () => {
      process.env.FROGCODE_BASE_URL = "http://env-host/v1";
      expect(resolveBaseUrl({ baseUrl: "http://opt-host/v1" })).toBe(
        "http://opt-host/v1",
      );
    });

    it("createProvider passes baseURL to OpenAIProvider when set", () => {
      const provider = createProvider(
        "openai",
        "key",
        "gpt-4o-mini",
        "http://localhost:8080/v1",
      );
      expect(provider).toBeInstanceOf(OpenAIProvider);
      expect(OpenAIProvider).toHaveBeenCalledWith({
        apiKey: "key",
        model: "gpt-4o-mini",
        baseURL: "http://localhost:8080/v1",
      });
    });

    it("createProvider omits baseURL when not set (uses provider default)", () => {
      createProvider("openai", "key", "gpt-4o-mini");
      expect(OpenAIProvider).toHaveBeenCalledWith({
        apiKey: "key",
        model: "gpt-4o-mini",
      });
    });

    it("createProvider passes baseURL to AnthropicProvider when set", () => {
      createProvider(
        "anthropic",
        "key",
        "claude-3-5-sonnet",
        "http://anthropic-proxy/v1",
      );
      expect(AnthropicProvider).toHaveBeenCalledWith({
        apiKey: "key",
        model: "claude-3-5-sonnet",
        baseURL: "http://anthropic-proxy/v1",
      });
    });

    it("chat command passes --base-url through to provider", async () => {
      process.env.OPENAI_API_KEY = "test-key";
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      const program = createProgram();
      await program.parseAsync([
        "node",
        "frogcode",
        "chat",
        "hello",
        "--base-url",
        "http://10.9.191.200/v1",
        "--no-stream",
      ]);

      expect(OpenAIProvider).toHaveBeenCalledWith({
        apiKey: "test-key",
        model: "gpt-4o-mini",
        baseURL: "http://10.9.191.200/v1",
      });
    });

    it("chat command uses FROGCODE_BASE_URL env when no --base-url flag", async () => {
      process.env.OPENAI_API_KEY = "test-key";
      process.env.FROGCODE_BASE_URL = "http://env-gateway/v1";
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      const program = createProgram();
      await program.parseAsync([
        "node",
        "frogcode",
        "chat",
        "hi",
        "--no-stream",
      ]);

      expect(OpenAIProvider).toHaveBeenCalledWith({
        apiKey: "test-key",
        model: "gpt-4o-mini",
        baseURL: "http://env-gateway/v1",
      });
    });
  });
});
