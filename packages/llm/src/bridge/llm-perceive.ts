import type { ExecutionContext, PerceiveHandler } from "@frogcode/core";
import type { AgentInput } from "@frogcode/core";
import type { PromptTemplate } from "../prompt/template.js";
import type { LLMProvider } from "../provider/interface.js";
import type { ChatRequest } from "../types/index.js";
import type { LLMHandlersOptions } from "./types.js";

/**
 * Perceive handler that turns an {@link AgentInput} into an LLM perception.
 *
 * Builds a {@link ChatRequest} whose single user message is either:
 *  - the rendered `"perceive"` template from the prompt registry (when one is
 *    registered), or
 *  - the raw `input.prompt` string.
 *
 * The returned perception is `ChatResponse.content` — a string ready to be
 * fed into {@link LLMReasonHandler}.
 */
export class LLMPerceiveHandler implements PerceiveHandler {
  private readonly provider: LLMProvider;
  private readonly model: string;
  private readonly perceiveTemplate?: PromptTemplate;

  constructor(provider: LLMProvider, opts: LLMHandlersOptions) {
    this.provider = provider;
    this.model = opts.model;
    this.perceiveTemplate = opts.promptRegistry?.get("perceive");
  }

  async perceive(input: AgentInput, ctx: ExecutionContext): Promise<unknown> {
    const content = this.renderContent(input);
    const req: ChatRequest = {
      messages: [
        {
          id: `perceive-${ctx.agentId}-${Date.now()}`,
          role: "user",
          content,
          timestamp: Date.now(),
        },
      ],
      model: this.model,
    };
    const res = await this.provider.chat(req, { signal: ctx.signal });
    return res.content;
  }

  private renderContent(input: AgentInput): string {
    if (this.perceiveTemplate) {
      return this.perceiveTemplate.render({
        prompt: input.prompt,
        context: input.context ?? {},
      });
    }
    return input.prompt;
  }
}
