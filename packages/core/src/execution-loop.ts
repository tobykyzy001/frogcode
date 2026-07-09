import type { EventStore } from "./event-store/types.js";
import type { ExecutionContext } from "./execution-context.js";
import type { PRAOHandlers } from "./handlers/types.js";
import type { AgentInput, AgentOutput } from "./types/agent.js";
import type { AgentConfig } from "./types/config.js";
import type { StepRecord, StepType } from "./types/step-record.js";

export class ExecutionLoop {
  constructor(
    private readonly handlers: PRAOHandlers,
    private readonly eventStore: EventStore,
    private readonly config: AgentConfig,
  ) {}

  async run(input: AgentInput, ctx: ExecutionContext): Promise<AgentOutput> {
    const steps: StepRecord[] = [];
    let perception: unknown;

    for (let i = 0; i < this.config.maxSteps; i++) {
      if (ctx.state === "paused") {
        break;
      }
      if (ctx.state === "failed") {
        throw new Error("Agent execution failed");
      }

      // Perceive
      perception = await this.handlers.perceive.perceive(input, ctx);
      const pRecord = this.#createStepRecord(
        ctx.agentId,
        "perceive",
        input,
        perception,
      );
      steps.push(pRecord);
      await this.eventStore.append(pRecord);

      // Reason
      const decision = await this.handlers.reason.reason(perception, ctx);
      const rRecord = this.#createStepRecord(
        ctx.agentId,
        "reason",
        perception,
        decision,
      );
      steps.push(rRecord);
      await this.eventStore.append(rRecord);

      // Act
      const actionResult = await this.handlers.act.act(decision, ctx);
      const aRecord = this.#createStepRecord(
        ctx.agentId,
        "act",
        decision,
        actionResult,
      );
      steps.push(aRecord);
      await this.eventStore.append(aRecord);

      // Observe
      const observation = await this.handlers.observe.observe(
        decision,
        actionResult,
        ctx,
      );
      const oRecord = this.#createStepRecord(
        ctx.agentId,
        "observe",
        actionResult,
        observation,
      );
      steps.push(oRecord);
      await this.eventStore.append(oRecord);
    }

    const lastObservation =
      steps.length > 0 ? steps[steps.length - 1].output : null;
    const content =
      typeof lastObservation === "object" && lastObservation !== null
        ? ((lastObservation as Record<string, unknown>).observation ??
          String(lastObservation))
        : String(lastObservation ?? "");

    return {
      content: typeof content === "string" ? content : String(content),
      steps,
      metadata: {},
    };
  }

  #createStepRecord(
    agentId: string,
    type: StepType,
    input: unknown,
    output: unknown,
  ): StepRecord {
    return {
      id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agentId,
      type,
      input,
      output,
      timestamp: Date.now(),
      duration: 0,
      metadata: {},
    };
  }
}
