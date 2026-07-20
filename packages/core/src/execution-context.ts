import type { AgentStateMachine } from "./state-machine.js";
import type { AgentState } from "./types/agent.js";
import type { AgentConfig } from "./types/config.js";
import { createAgentConfig } from "./types/config.js";

export class ExecutionContext {
  readonly agentId: string;
  readonly config: AgentConfig;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: number;
  readonly parent?: ExecutionContext;
  readonly signal: AbortSignal;
  readonly #stateMachine: AgentStateMachine;

  constructor(opts: {
    agentId: string;
    config: AgentConfig;
    stateMachine: AgentStateMachine;
    metadata?: Record<string, unknown>;
    parent?: ExecutionContext;
    signal?: AbortSignal;
  }) {
    this.agentId = opts.agentId;
    this.config = opts.config;
    this.#stateMachine = opts.stateMachine;
    this.metadata = opts.metadata ?? {};
    this.createdAt = Date.now();
    this.parent = opts.parent;
    this.signal = opts.signal ?? new AbortController().signal;
  }

  get state(): AgentState {
    return this.#stateMachine.state;
  }

  set(key: string, value: unknown): void {
    this.metadata[key] = value;
  }

  get<T = unknown>(key: string): T | undefined {
    return this.metadata[key] as T | undefined;
  }

  has(key: string): boolean {
    return key in this.metadata;
  }

  createChild(
    agentId: string,
    config?: Partial<AgentConfig>,
  ): ExecutionContext {
    const childConfig = config
      ? createAgentConfig({ ...config, name: config.name ?? this.config.name })
      : this.config;
    return new ExecutionContext({
      agentId,
      config: childConfig,
      stateMachine: this.#stateMachine,
      metadata: { ...this.metadata },
      parent: this,
    });
  }

  /**
   * Returns a new context with the same agentId, config, stateMachine, and
   * inherited metadata, but with the `signal` replaced. Unlike createChild,
   * this does NOT set `parent` (shallow copy semantics — the new context is a
   * peer, not a sub-scope).
   */
  withSignal(signal: AbortSignal): ExecutionContext {
    return new ExecutionContext({
      agentId: this.agentId,
      config: this.config,
      stateMachine: this.#stateMachine,
      metadata: { ...this.metadata },
      signal,
    });
  }

  toJSON(): string {
    return JSON.stringify({
      agentId: this.agentId,
      config: this.config,
      state: this.state,
      metadata: this.metadata,
      createdAt: this.createdAt,
      parentAgentId: this.parent?.agentId,
    });
  }
}
