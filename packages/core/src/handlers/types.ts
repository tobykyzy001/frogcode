import type { ExecutionContext } from "../execution-context.js";
import type { AgentInput } from "../types/agent.js";

export interface PerceiveHandler {
  perceive(input: AgentInput, ctx: ExecutionContext): Promise<unknown>;
}

export interface ReasonHandler {
  reason(perception: unknown, ctx: ExecutionContext): Promise<unknown>;
}

export interface ActHandler {
  act(decision: unknown, ctx: ExecutionContext): Promise<unknown>;
}

export interface ObserveHandler {
  observe(
    action: unknown,
    result: unknown,
    ctx: ExecutionContext,
  ): Promise<unknown>;
}

export interface PRAOHandlers {
  perceive: PerceiveHandler;
  reason: ReasonHandler;
  act: ActHandler;
  observe: ObserveHandler;
}
