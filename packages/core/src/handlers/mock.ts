import type { ExecutionContext } from "../execution-context.js";
import type { AgentInput } from "../types/agent.js";
import type { PRAOHandlers } from "./types.js";

class MockPerceiveHandler {
  async perceive(input: AgentInput, _ctx: ExecutionContext): Promise<unknown> {
    return { rawInput: input.prompt };
  }
}

class MockReasonHandler {
  async reason(perception: unknown, _ctx: ExecutionContext): Promise<unknown> {
    const p = perception as { rawInput: string };
    return { action: "echo", target: p.rawInput };
  }
}

class MockActHandler {
  async act(decision: unknown, _ctx: ExecutionContext): Promise<unknown> {
    const d = decision as { target: string };
    return { result: d.target };
  }
}

class MockObserveHandler {
  async observe(
    _action: unknown,
    result: unknown,
    _ctx: ExecutionContext,
  ): Promise<unknown> {
    const r = result as { result: string };
    return { observation: r.result, timestamp: Date.now() };
  }
}

export function createMockHandlers(): PRAOHandlers {
  return {
    perceive: new MockPerceiveHandler(),
    reason: new MockReasonHandler(),
    act: new MockActHandler(),
    observe: new MockObserveHandler(),
  };
}
