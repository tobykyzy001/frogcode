import type {
  CallOptions,
  ChatChunk,
  ChatRequest,
  ChatResponse,
  EmbedResponse,
} from "../types/index.js";

export interface LLMProvider {
  chat(req: ChatRequest, opts?: CallOptions): Promise<ChatResponse>;
  stream(req: ChatRequest, opts?: CallOptions): AsyncIterable<ChatChunk>;
  embed(text: string, opts?: CallOptions): Promise<EmbedResponse>;
}
