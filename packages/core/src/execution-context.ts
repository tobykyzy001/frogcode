import type { AgentState } from "./types/agent.js";
import type { AgentConfig } from "./types/config.js";
import { createAgentConfig } from "./types/config.js";

export class ExecutionContext {
  readonly agentId: string;
  readonly config: AgentConfig;
  readonly state: AgentState;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: number;
  readonly parent?: ExecutionContext;

  constructor(opts: {
    agentId: string;
    config: AgentConfig;
    state: AgentState;
    metadata?: Record<string, unknown>;
    parent?: ExecutionContext;
  }) {
    this.agentId = opts.agentId;
    this.config = opts.config;
    this.state = opts.state;
    this.metadata = opts.metadata ?? {};
    this.createdAt = Date.now();
    this.parent = opts.parent;
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
      state: this.state,
      metadata: { ...this.metadata },
      parent: this,
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
