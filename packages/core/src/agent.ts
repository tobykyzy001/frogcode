import { randomUUID } from "node:crypto";
import { InMemoryEventStore } from "./event-store/in-memory.js";
import type { EventStore } from "./event-store/types.js";
import { ExecutionContext } from "./execution-context.js";
import { AgentAbortedError, ExecutionLoop } from "./execution-loop.js";
import { createMockHandlers } from "./handlers/mock.js";
import type { PRAOHandlers } from "./handlers/types.js";
import { AgentStateMachine } from "./state-machine.js";
import type { AgentInput, AgentOutput, AgentState } from "./types/agent.js";
import type { AgentConfig } from "./types/config.js";
import { createAgentConfig } from "./types/config.js";

export class Agent {
  readonly id: string;
  readonly config: AgentConfig;

  #stateMachine: AgentStateMachine;
  #loop: ExecutionLoop;
  #eventStore: EventStore;

  constructor(opts: {
    id: string;
    config: AgentConfig;
    handlers?: PRAOHandlers;
    eventStore?: EventStore;
  }) {
    this.id = opts.id;
    this.config = opts.config;
    this.#stateMachine = new AgentStateMachine();
    this.#eventStore = opts.eventStore ?? new InMemoryEventStore();
    this.#loop = new ExecutionLoop(
      opts.handlers ?? createMockHandlers(),
      this.#eventStore,
      this.config,
      this.#stateMachine,
    );
  }

  get state(): AgentState {
    return this.#stateMachine.state;
  }

  async run(input: AgentInput): Promise<AgentOutput> {
    if (this.#stateMachine.state !== "idle") {
      throw new Error(
        `Cannot run from state: ${this.#stateMachine.state}. Use resume() if paused, or reset() if terminated.`,
      );
    }

    this.#stateMachine.transition("running");
    const ctx = new ExecutionContext({
      agentId: this.id,
      config: this.config,
      stateMachine: this.#stateMachine,
    });

    try {
      const result = await this.#loop.run(input, ctx);
      this.#finalizeAfterLoop();
      return result;
    } catch (error) {
      this.#finalizeAfterFailure();
      throw error;
    }
  }

  async resume(): Promise<AgentOutput> {
    if (this.#stateMachine.state !== "paused") {
      throw new Error(`Cannot resume from state: ${this.#stateMachine.state}`);
    }

    this.#stateMachine.transition("running");

    try {
      const result = await this.#loop.resume();
      this.#finalizeAfterLoop();
      return result;
    } catch (error) {
      this.#finalizeAfterFailure();
      throw error;
    }
  }

  #finalizeAfterLoop(): void {
    if (this.#stateMachine.state === "running") {
      this.#stateMachine.transition("completed");
    }
  }

  #finalizeAfterFailure(): void {
    const state = this.#stateMachine.state;
    if (state === "running") {
      this.#stateMachine.transition("failed");
    }
  }

  pause(): void {
    this.#stateMachine.transition("paused");
  }

  abort(): void {
    this.#stateMachine.transition("aborted");
  }

  reset(): void {
    const state = this.#stateMachine.state;
    if (state !== "completed" && state !== "failed" && state !== "aborted") {
      throw new Error(
        `Cannot reset from state: ${state}. Agent must be in a terminal state.`,
      );
    }
    this.#stateMachine.transition("idle");
    this.#loop.reset();
  }

  static create(
    opts: Partial<AgentConfig> & {
      id?: string;
      handlers?: PRAOHandlers;
      eventStore?: EventStore;
    },
  ): Agent {
    const id = opts.id ?? `agent-${randomUUID()}`;
    const config = createAgentConfig({
      ...opts,
      name: opts.name ?? id,
    });
    return new Agent({
      id,
      config,
      handlers: opts.handlers,
      eventStore: opts.eventStore,
    });
  }
}
