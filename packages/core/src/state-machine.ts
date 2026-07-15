import type { AgentState } from "./types/agent.js";

export class InvalidStateTransitionError extends Error {
  constructor(
    public readonly from: AgentState,
    public readonly to: AgentState,
  ) {
    super(`Invalid state transition: ${from} -> ${to}`);
    this.name = "InvalidStateTransitionError";
  }
}

const VALID_TRANSITIONS: Record<AgentState, AgentState[]> = {
  idle: ["running"],
  running: ["waiting", "finished", "failed", "aborted"],
  waiting: ["running", "aborted"],
  finished: ["idle"],
  failed: ["idle"],
  aborted: ["idle"],
};

export class AgentStateMachine {
  #state: AgentState = "idle";
  #listeners: Array<(from: AgentState, to: AgentState) => void> = [];

  get state(): AgentState {
    return this.#state;
  }

  canTransition(to: AgentState): boolean {
    return VALID_TRANSITIONS[this.#state].includes(to);
  }

  transition(to: AgentState): void {
    if (!this.canTransition(to)) {
      throw new InvalidStateTransitionError(this.#state, to);
    }
    const from = this.#state;
    this.#state = to;
    for (const listener of this.#listeners) {
      listener(from, to);
    }
  }

  onTransition(
    callback: (from: AgentState, to: AgentState) => void,
  ): () => void {
    this.#listeners.push(callback);
    return () => {
      const idx = this.#listeners.indexOf(callback);
      if (idx !== -1) this.#listeners.splice(idx, 1);
    };
  }
}
