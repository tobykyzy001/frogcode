import {
  AbortedError,
  InvalidResponseError,
  LLMError,
  LLMRetryExhaustedError,
  NetworkError,
  RateLimitError,
  TokenBudgetExceededError,
  UnsupportedError,
} from "@frogcode/llm";
import { describe, expect, it } from "vitest";
import { formatError } from "../src/errors/format-error.js";

describe("formatError", () => {
  it("formats RateLimitError with retryAfter to include the wait time", () => {
    const error = new RateLimitError("rate limited", { retryAfter: 5 });
    const message = formatError(error);
    expect(message).toContain("等待 5s");
    expect(message.startsWith("⏳")).toBe(true);
  });

  it("formats RateLimitError without retryAfter to omit the wait time", () => {
    const error = new RateLimitError("rate limited");
    const message = formatError(error);
    expect(message).toContain("请求频率限制");
    expect(message).not.toContain("等待");
    expect(message.startsWith("⏳")).toBe(true);
  });

  it("formats NetworkError with the network emoji prefix", () => {
    const error = new NetworkError("connection reset");
    const message = formatError(error);
    expect(message.startsWith("🌐 网络错误:")).toBe(true);
    expect(message).toContain("connection reset");
  });

  it("formats TokenBudgetExceededError with the token emoji prefix", () => {
    const error = new TokenBudgetExceededError(1100, 1000, 100);
    const message = formatError(error);
    expect(message.startsWith("💰 Token 预算超限")).toBe(true);
    expect(message).toContain("Token budget exceeded");
  });

  it("formats LLMRetryExhaustedError with attempt count and inner message", () => {
    const inner = new Error("upstream 500");
    const error = new LLMRetryExhaustedError(inner, 4);
    const message = formatError(error);
    expect(message).toContain("重试耗尽");
    expect(message).toContain("4");
    expect(message).toContain("upstream 500");
  });

  it("formats LLMRetryExhaustedError when lastError is a non-Error value", () => {
    const error = new LLMRetryExhaustedError("string-failure", 2);
    const message = formatError(error);
    expect(message).toContain("重试耗尽");
    expect(message).toContain("2");
    expect(message).toContain("string-failure");
  });

  it("formats AbortedError with the abort emoji prefix", () => {
    const error = new AbortedError("user cancelled");
    const message = formatError(error);
    expect(message).toBe("🛑 请求已取消");
  });

  it("formats InvalidResponseError with the invalid response prefix", () => {
    const error = new InvalidResponseError("bad JSON");
    const message = formatError(error);
    expect(message.startsWith("⚠️ 无效响应:")).toBe(true);
    expect(message).toContain("bad JSON");
  });

  it("formats UnsupportedError with the unsupported prefix", () => {
    const error = new UnsupportedError("vision");
    const message = formatError(error);
    expect(message.startsWith("⚠️ 不支持的操作:")).toBe(true);
    expect(message).toContain("vision");
  });

  it("formats base LLMError with the generic LLM prefix", () => {
    const error = new LLMError("provider boom");
    const message = formatError(error);
    expect(message.startsWith("⚠️ LLM 错误:")).toBe(true);
    expect(message).toContain("provider boom");
  });

  it("formats generic Error with the cross emoji prefix", () => {
    const error = new Error("disk full");
    const message = formatError(error);
    expect(message.startsWith("❌")).toBe(true);
    expect(message).toContain("disk full");
  });

  it("formats non-Error values as unknown errors", () => {
    const message = formatError("boom");
    expect(message.startsWith("❌ 未知错误:")).toBe(true);
    expect(message).toContain("boom");
  });

  it("passes through API key missing error message unchanged", () => {
    const error = new Error("❌ 未设置 OPENAI_API_KEY 环境变量");
    const message = formatError(error);
    expect(message).toBe("❌ 未设置 OPENAI_API_KEY 环境变量");
  });
});
