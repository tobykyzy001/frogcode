import type { PRAOHandlers } from "@frogcode/core";
import type { LLMProvider } from "../provider/interface.js";
import { EchoActHandler } from "./echo-act.js";
import { LLMObserveHandler } from "./llm-observe.js";
import { LLMPerceiveHandler } from "./llm-perceive.js";
import { LLMReasonHandler } from "./llm-reason.js";
import type { LLMHandlersOptions } from "./types.js";

/**
 * Build a {@link PRAOHandlers} implementation that bridges an
 * {@link LLMProvider} to the core PRAO execution loop.
 *
 * The returned handlers are independent instances wired to the same provider
 * and options snapshot. The `act` handler is an {@link EchoActHandler}
 * placeholder — Phase 3 will swap in a tool-registry-backed handler.
 */
export function createLLMHandlers(
  provider: LLMProvider,
  opts: LLMHandlersOptions,
): PRAOHandlers {
  return {
    perceive: new LLMPerceiveHandler(provider, opts),
    reason: new LLMReasonHandler(provider, opts),
    act: new EchoActHandler(),
    observe: new LLMObserveHandler(),
  };
}
