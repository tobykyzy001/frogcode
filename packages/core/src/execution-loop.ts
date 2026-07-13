import { randomUUID } from "node:crypto";
import { isRetryableError } from "./errors.js";
import type { EventStore } from "./event-store/types.js";
import type { ExecutionContext } from "./execution-context.js";
import type { PRAOHandlers, ReasonResult } from "./handlers/types.js";
import type { AgentStateMachine } from "./state-machine.js";
import type { AgentInput, AgentOutput } from "./types/agent.js";
import type { AgentConfig } from "./types/config.js";
import type { StepRecord, StepType } from "./types/step-record.js";

export class StepTimeoutError extends Error {
  constructor(
    public readonly stepType: StepType,
    public readonly timeoutMs: number,
  ) {
    super(`Step '${stepType}' timed out after ${timeoutMs}ms`);
    this.name = "StepTimeoutError";
  }
}

export class AgentAbortedError extends Error {
  constructor() {
    super("Agent execution was aborted");
    this.name = "AgentAbortedError";
  }
}

export class NoExecutionToResumeError extends Error {
  constructor() {
    super("Cannot resume: no previous execution to continue");
    this.name = "NoExecutionToResumeError";
  }
}

type CyclePhase = "perceive" | "reason" | "act" | "observe";

export class ExecutionLoop {
  #accumulatedSteps: StepRecord[] = [];
  #currentInput: AgentInput | null = null;
  #currentCtx: ExecutionContext | null = null;
  #cycleIndex = 0;
  #phase: CyclePhase = "perceive";
  #perception: unknown = null;
  #decision: unknown = null;
  #actionResult: unknown = null;
  #done = false;
  #pauseCause: unknown = null;

  constructor(
    private readonly handlers: PRAOHandlers,
    private readonly eventStore: EventStore,
    private readonly config: AgentConfig,
    private readonly stateMachine: AgentStateMachine,
  ) {}

  async run(input: AgentInput, ctx: ExecutionContext): Promise<AgentOutput> {
    this.#accumulatedSteps = [];
    this.#currentInput = input;
    this.#currentCtx = ctx;
    this.#cycleIndex = 0;
    this.#phase = "perceive";
    this.#perception = null;
    this.#decision = null;
    this.#actionResult = null;
    this.#done = false;
    this.#pauseCause = null;
    return this.#execute();
  }

  async resume(): Promise<AgentOutput> {
    if (this.#currentInput === null || this.#currentCtx === null) {
      throw new NoExecutionToResumeError();
    }
    return this.#execute();
  }

  reset(): void {
    this.#accumulatedSteps = [];
    this.#currentInput = null;
    this.#currentCtx = null;
    this.#cycleIndex = 0;
    this.#phase = "perceive";
    this.#perception = null;
    this.#decision = null;
    this.#actionResult = null;
    this.#done = false;
    this.#pauseCause = null;
  }

  async #execute(): Promise<AgentOutput> {
    if (this.#currentCtx === null || this.#currentInput === null) {
      throw new NoExecutionToResumeError();
    }
    const ctx = this.#currentCtx;
    const input = this.#currentInput;
    const agentId = ctx.agentId;

    for (; this.#cycleIndex < this.config.maxSteps; this.#cycleIndex++) {
      if (this.#shouldStop()) break;

      try {
        if (this.#phase === "perceive") {
          this.#perception = await this.#runStep(
            agentId,
            "perceive",
            input,
            () => this.handlers.perceive.perceive(input, ctx),
          );
          this.#phase = "reason";
        }
        if (this.#shouldStop()) break;

        if (this.#phase === "reason") {
          const reasonResult = (await this.#runStep(
            agentId,
            "reason",
            this.#perception,
            () => this.handlers.reason.reason(this.#perception, ctx),
          )) as ReasonResult;
          this.#decision = reasonResult.action;
          this.#done = reasonResult.done === true;
          this.#phase = "act";
        }
        if (this.#shouldStop()) break;

        if (this.#phase === "act") {
          this.#actionResult = await this.#runStep(
            agentId,
            "act",
            this.#decision,
            () => this.handlers.act.act(this.#decision, ctx),
          );
          this.#phase = "observe";
        }
        if (this.#shouldStop()) break;

        if (this.#phase === "observe") {
          await this.#runStep(agentId, "observe", this.#actionResult, () =>
            this.handlers.observe.observe(
              this.#decision,
              this.#actionResult,
              ctx,
            ),
          );
          this.#phase = "perceive";
        }

        if (this.#done) {
          this.#cycleIndex++;
          break;
        }
      } catch (error) {
        // State already changed (pause/abort/fail) during handler execution
        if (this.#shouldStop()) {
          break;
        }
        // pauseOnFailure: transition to paused instead of propagating error
        if (this.config.pauseOnFailure) {
          this.#pauseCause = error;
          this.stateMachine.transition("paused");
          break;
        }
        throw error;
      }
    }

    return this.#finalizeExecution();
  }

  #shouldStop(): boolean {
    const state = this.stateMachine.state;
    return state === "paused" || state === "aborted" || state === "failed";
  }

  async #runStep(
    agentId: string,
    type: StepType,
    input: unknown,
    fn: () => Promise<unknown>,
  ): Promise<unknown> {
    const start = Date.now();
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (this.#shouldStop()) {
        throw new AgentAbortedError();
      }

      try {
        const result = await this.#withTimeout(fn(), type);
        const duration = Date.now() - start;
        const record: StepRecord = {
          id: `step-${randomUUID()}`,
          agentId,
          type,
          input,
          output: result,
          timestamp: start,
          duration,
          metadata: { attempt: attempt + 1, status: "completed" },
        };
        this.#accumulatedSteps.push(record);
        await this.eventStore.append(record);
        return result;
      } catch (error) {
        lastError = error;

        if (this.#shouldStop()) {
          const duration = Date.now() - start;
          const record = this.#createFailedRecord(
            agentId,
            type,
            input,
            start,
            duration,
            attempt + 1,
            error,
          );
          this.#accumulatedSteps.push(record);
          await this.eventStore.append(record);
          throw error;
        }

        // Error classification: non-retryable errors fail immediately
        const classifier =
          this.config.retryableErrorClassifier ?? isRetryableError;
        if (!classifier(error, attempt + 1)) {
          const duration = Date.now() - start;
          const record = this.#createFailedRecord(
            agentId,
            type,
            input,
            start,
            duration,
            attempt + 1,
            error,
          );
          this.#accumulatedSteps.push(record);
          await this.eventStore.append(record);
          throw error;
        }
        // Retryable: continue to next attempt
      }
    }

    // All retries exhausted — record and throw
    const duration = Date.now() - start;
    const record = this.#createFailedRecord(
      agentId,
      type,
      input,
      start,
      duration,
      this.config.maxRetries + 1,
      lastError,
    );
    this.#accumulatedSteps.push(record);
    await this.eventStore.append(record);
    throw lastError;
  }

  #withTimeout<T>(promise: Promise<T>, type: StepType): Promise<T> {
    if (this.config.stepTimeoutMs <= 0) return promise;

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new StepTimeoutError(type, this.config.stepTimeoutMs)),
        this.config.stepTimeoutMs,
      );
    });

    return Promise.race([promise, timeout]).finally(() => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    });
  }

  #createFailedRecord(
    agentId: string,
    type: StepType,
    input: unknown,
    start: number,
    duration: number,
    attempt: number,
    error: unknown,
  ): StepRecord {
    return {
      id: `step-${randomUUID()}`,
      agentId,
      type,
      input,
      output: null,
      timestamp: start,
      duration,
      metadata: {
        attempt,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : "Unknown",
      },
    };
  }

  #finalizeExecution(): AgentOutput {
    const state = this.stateMachine.state;
    if (state === "aborted") {
      throw new AgentAbortedError();
    }
    if (state === "paused" && this.#pauseCause !== null) {
      throw this.#pauseCause;
    }
    return { steps: [...this.#accumulatedSteps] };
  }
}
