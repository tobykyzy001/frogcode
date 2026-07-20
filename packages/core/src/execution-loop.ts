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
            (stepCtx) => this.handlers.perceive.perceive(input, stepCtx),
            ctx,
          );
          this.#phase = "reason";
        }
        if (this.#shouldStop()) break;

        if (this.#phase === "reason") {
          const reasonResult = (await this.#runStep(
            agentId,
            "reason",
            this.#perception,
            (stepCtx) => this.handlers.reason.reason(this.#perception, stepCtx),
            ctx,
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
            (stepCtx) => this.handlers.act.act(this.#decision, stepCtx),
            ctx,
          );
          this.#phase = "observe";
        }
        if (this.#shouldStop()) break;

        if (this.#phase === "observe") {
          await this.#runStep(
            agentId,
            "observe",
            this.#actionResult,
            (stepCtx) =>
              this.handlers.observe.observe(
                this.#decision,
                this.#actionResult,
                stepCtx,
              ),
            ctx,
          );
          this.#phase = "perceive";
        }

        if (this.#done) {
          this.#cycleIndex++;
          break;
        }
      } catch (error) {
        // waiting is a normal interruption (subagent coordination) — return steps
        if (this.stateMachine.state === "waiting") {
          break;
        }
        // aborted / failed / step errors — propagate to caller
        throw error;
      }
    }

    return this.#finalizeExecution();
  }

  #shouldStop(): boolean {
    const state = this.stateMachine.state;
    return state === "waiting" || state === "aborted" || state === "failed";
  }

  async #runStep(
    agentId: string,
    type: StepType,
    input: unknown,
    fn: (ctx: ExecutionContext) => Promise<unknown>,
    ctx: ExecutionContext,
  ): Promise<unknown> {
    const start = Date.now();
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (this.#shouldStop()) {
        throw new AgentAbortedError();
      }

      const stepController = new AbortController();
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      if (this.config.stepTimeoutMs > 0) {
        timeoutId = setTimeout(
          () =>
            stepController.abort(
              new StepTimeoutError(type, this.config.stepTimeoutMs),
            ),
          this.config.stepTimeoutMs,
        );
      }

      // Propagate agent-level abort to the step controller (single layer, no recursion)
      const onParentAbort = () => stepController.abort(ctx.signal.reason);
      if (ctx.signal.aborted) {
        stepController.abort(ctx.signal.reason);
      } else {
        ctx.signal.addEventListener("abort", onParentAbort, { once: true });
      }

      try {
        const stepCtx = ctx.withSignal(stepController.signal);
        // Race handler against stepController abort so that timeout/agent-abort
        // rejects the await with the abort reason (StepTimeoutError or parent reason).
        // Pass a factory so we don't invoke the handler (and create an unhandled
        // promise) when the signal is already aborted.
        const result = await this.#raceWithSignal(
          () => fn(stepCtx),
          stepController.signal,
        );
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
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        ctx.signal.removeEventListener("abort", onParentAbort);
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

  /**
   * Races a handler factory against the step's AbortSignal. If the signal is
   * already aborted, the factory is NOT invoked and the returned promise
   * rejects with `signal.reason` immediately. If the signal aborts while the
   * handler is running, the promise rejects with `signal.reason`. The handler
   * promise is NOT cancelled (JavaScript promises cannot be), but a
   * signal-aware handler can observe `ctx.signal.aborted` and exit early.
   */
  #raceWithSignal<T>(
    factory: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    if (signal.aborted) {
      return Promise.reject(signal.reason);
    }
    const promise = factory();
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
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
    if (state === "failed") {
      throw new Error("Agent execution failed");
    }
    return { steps: [...this.#accumulatedSteps] };
  }
}
