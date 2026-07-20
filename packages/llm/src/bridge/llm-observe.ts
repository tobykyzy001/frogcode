import type {
  ExecutionContext,
  ObserveHandler,
  ObserveResult,
} from "@frogcode/core";

/**
 * Observe handler that stringifies the action result for the next prompt
 * cycle. The result is surfaced as `ObserveResult.content` so the
 * execution loop / next perceive step can pick it up.
 */
export class LLMObserveHandler implements ObserveHandler {
  async observe(
    _decision: unknown,
    actionResult: unknown,
    _ctx: ExecutionContext,
  ): Promise<ObserveResult> {
    return { content: String(actionResult) };
  }
}
