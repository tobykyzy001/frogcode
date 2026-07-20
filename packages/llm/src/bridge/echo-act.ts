import type { ActHandler, ExecutionContext } from "@frogcode/core";

/**
 * Placeholder {@link ActHandler} that returns the decision unchanged.
 *
 * Phase 3 will replace this with a real {@link ToolRegistry}-backed handler
 * that actually executes the tool call produced by the reason step. Until
 * then, echoing the decision through the PRAO loop lets the rest of the
 * pipeline (observe, multi-cycle flow) be exercised end-to-end.
 */
export class EchoActHandler implements ActHandler {
  async act(decision: unknown, _ctx: ExecutionContext): Promise<unknown> {
    return decision;
  }
}
