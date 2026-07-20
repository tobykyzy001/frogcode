import type { Message } from "@frogcode/core";

export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter";

export interface CallOptions {
  signal?: AbortSignal;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  messages: Message[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
}

export interface ChatResponse {
  content: string;
  usage: TokenUsage;
  finishReason: FinishReason;
  model: string;
  toolCalls?: ToolCall[];
}

export interface ChatChunkDelta {
  content?: string;
  toolCall?: Partial<ToolCall>;
}

export interface ChatChunk {
  delta: ChatChunkDelta;
  usage?: TokenUsage;
  finishReason?: FinishReason;
}

export interface EmbedResponse {
  embedding: number[];
  usage: TokenUsage;
  model: string;
}
