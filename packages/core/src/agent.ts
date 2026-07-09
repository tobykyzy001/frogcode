import { InMemoryEventStore } from "./event-store/in-memory.js";
import type { EventStore } from "./event-store/types.js";
import { ExecutionContext } from "./execution-context.js";
import { ExecutionLoop } from "./execution-loop.js";
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
    );
  }

  get state(): AgentState {
    return this.#stateMachine.state;
  }

  async run(input: AgentInput): Promise<AgentOutput> {
    this.#stateMachine.transition("running");
    const ctx = new ExecutionContext({
      agentId: this.id,
      config: this.config,
      state: this.#stateMachine.state,
    });
    try {
      const result = await this.#loop.run(input, ctx);
      this.#stateMachine.transition("completed");
      return result;
    } catch (error) {
      this.#stateMachine.transition("failed");
      throw error;
    }
  }

  pause(): void {
    this.#stateMachine.transition("paused");
  }

  resume(): void {
    this.#stateMachine.transition("running");
  }

  abort(): void {
    this.#stateMachine.transition("failed");
  }

  static create(opts: Partial<AgentConfig> & { id?: string }): Agent {
    const id = opts.id ?? `agent-${Date.now()}`;
    const config = createAgentConfig({ ...opts, name: opts.name ?? id });
    return new Agent({ id, config });
  }
}
