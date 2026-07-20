import type { TokenUsage } from "../types/index.js";
import { TokenBudgetExceededError } from "./token-budget-error.js";

export interface TokenBudgetOptions {
  maxTokens: number;
}

export interface TokenBudgetSnapshot {
  used: number;
  max: number;
  remaining: number;
}

export class TokenBudget {
  readonly max: number;
  #used = 0;

  constructor(options: TokenBudgetOptions) {
    this.max = options.maxTokens;
  }

  track(usage: TokenUsage): void {
    this.#used += usage.totalTokens;
  }

  check(): void {
    if (this.#used > this.max) {
      throw new TokenBudgetExceededError(
        this.#used,
        this.max,
        this.#used - this.max,
      );
    }
  }

  snapshot(): TokenBudgetSnapshot {
    return {
      used: this.#used,
      max: this.max,
      remaining: Math.max(0, this.max - this.#used),
    };
  }
}
