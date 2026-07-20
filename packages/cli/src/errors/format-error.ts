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

export function formatError(error: unknown): string {
  if (
    error instanceof Error &&
    error.message.includes("未设置") &&
    error.message.includes("环境变量")
  ) {
    return error.message;
  }

  if (error instanceof RateLimitError) {
    const retryAfter = error.retryAfter;
    if (retryAfter !== undefined) {
      return `⏳ 请求频率限制，重试中... (等待 ${retryAfter}s)`;
    }
    return "⏳ 请求频率限制，重试中...";
  }

  if (error instanceof NetworkError) {
    return `🌐 网络错误: ${error.message}`;
  }

  if (error instanceof TokenBudgetExceededError) {
    return `💰 Token 预算超限 (${error.message})`;
  }

  if (error instanceof LLMRetryExhaustedError) {
    const lastErr = error.lastError;
    const lastMsg =
      lastErr instanceof Error ? lastErr.message : String(lastErr);
    return `❌ 重试耗尽，已失败 ${error.attempts} 次: ${lastMsg}`;
  }

  if (error instanceof AbortedError) {
    return "🛑 请求已取消";
  }

  if (error instanceof InvalidResponseError) {
    return `⚠️ 无效响应: ${error.message}`;
  }

  if (error instanceof UnsupportedError) {
    return `⚠️ 不支持的操作: ${error.message}`;
  }

  if (error instanceof LLMError) {
    return `⚠️ LLM 错误: ${error.message}`;
  }

  if (error instanceof Error) {
    return `❌ ${error.message}`;
  }

  return `❌ 未知错误: ${String(error)}`;
}
