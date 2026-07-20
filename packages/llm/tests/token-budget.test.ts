import { describe, expect, it } from "vitest";
import { TokenBudgetExceededError } from "../src/provider/token-budget-error.js";
import { TokenBudget } from "../src/provider/token-budget.js";
import type { TokenUsage } from "../src/types/index.js";

describe("TokenBudgetExceededError", () => {
  it("is an instanceof Error and TokenBudgetExceededError", () => {
    const err = new TokenBudgetExceededError(110, 100, 10);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TokenBudgetExceededError);
  });

  it("sets name to 'TokenBudgetExceededError'", () => {
    const err = new TokenBudgetExceededError(110, 100, 10);
    expect(err.name).toBe("TokenBudgetExceededError");
  });

  it("exposes readonly used, max, and exceeded fields", () => {
    const err = new TokenBudgetExceededError(110, 100, 10);
    expect(err.used).toBe(110);
    expect(err.max).toBe(100);
    expect(err.exceeded).toBe(10);
  });

  it("formats the message including used, max, and exceeded values", () => {
    const err = new TokenBudgetExceededError(110, 100, 10);
    expect(err.message).toBe(
      "Token budget exceeded: used 110 of 100 (over by 10)",
    );
  });

  it("does not coerce or recompute the exceeded argument", () => {
    // Caller-supplied exceeded is the source of truth at throw time.
    const err = new TokenBudgetExceededError(105, 100, 5);
    expect(err.exceeded).toBe(5);
    expect(err.message).toContain("over by 5");
  });
});

describe("TokenBudget", () => {
  describe("construction", () => {
    it("accepts { maxTokens } options and exposes max in snapshot", () => {
      const budget = new TokenBudget({ maxTokens: 1000 });
      expect(budget.snapshot().max).toBe(1000);
    });

    it("starts with used === 0 and remaining === max", () => {
      const budget = new TokenBudget({ maxTokens: 500 });
      const snap = budget.snapshot();
      expect(snap.used).toBe(0);
      expect(snap.remaining).toBe(500);
    });
  });

  describe("track", () => {
    it("accumulates totalTokens across multiple track() calls", () => {
      const budget = new TokenBudget({ maxTokens: 1000 });
      const u1: TokenUsage = {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      };
      const u2: TokenUsage = {
        promptTokens: 200,
        completionTokens: 100,
        totalTokens: 300,
      };
      budget.track(u1);
      budget.track(u2);
      const snap = budget.snapshot();
      expect(snap.used).toBe(450);
      expect(snap.remaining).toBe(550);
      expect(snap.max).toBe(1000);
    });

    it("uses the provider-reported totalTokens field (not prompt+completion recomputed)", () => {
      // totalTokens is authoritative; pass an inconsistent total to confirm.
      const budget = new TokenBudget({ maxTokens: 1000 });
      const weird: TokenUsage = {
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 999,
      };
      budget.track(weird);
      expect(budget.snapshot().used).toBe(999);
    });
  });

  describe("snapshot", () => {
    it("returns { used, max, remaining }", () => {
      const budget = new TokenBudget({ maxTokens: 2000 });
      budget.track({
        promptTokens: 300,
        completionTokens: 200,
        totalTokens: 500,
      });
      expect(budget.snapshot()).toEqual({
        used: 500,
        max: 2000,
        remaining: 1500,
      });
    });

    it("clamps remaining to 0 when used exceeds max", () => {
      const budget = new TokenBudget({ maxTokens: 100 });
      budget.track({
        promptTokens: 80,
        completionTokens: 50,
        totalTokens: 130,
      });
      const snap = budget.snapshot();
      expect(snap.used).toBe(130);
      expect(snap.remaining).toBe(0);
    });
  });

  describe("check", () => {
    it("does not throw when used is under max", () => {
      const budget = new TokenBudget({ maxTokens: 1000 });
      budget.track({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      });
      expect(() => budget.check()).not.toThrow();
    });

    it("does not throw when used equals max exactly (boundary)", () => {
      const budget = new TokenBudget({ maxTokens: 100 });
      budget.track({
        promptTokens: 60,
        completionTokens: 40,
        totalTokens: 100,
      });
      expect(() => budget.check()).not.toThrow();
    });

    it("throws TokenBudgetExceededError when used > max", () => {
      const budget = new TokenBudget({ maxTokens: 100 });
      budget.track({
        promptTokens: 60,
        completionTokens: 50,
        totalTokens: 110,
      });
      expect(() => budget.check()).toThrow(TokenBudgetExceededError);
    });

    it("throws an error carrying the actual used/max/exceeded at throw time", () => {
      const budget = new TokenBudget({ maxTokens: 100 });
      budget.track({
        promptTokens: 60,
        completionTokens: 50,
        totalTokens: 110,
      });
      try {
        budget.check();
        throw new Error("expected check() to throw");
      } catch (e) {
        expect(e).toBeInstanceOf(TokenBudgetExceededError);
        if (e instanceof TokenBudgetExceededError) {
          expect(e.used).toBe(110);
          expect(e.max).toBe(100);
          expect(e.exceeded).toBe(10);
        }
      }
    });

    it("is idempotent: calling check() multiple times does not change state", () => {
      const budget = new TokenBudget({ maxTokens: 200 });
      budget.track({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      });
      expect(() => budget.check()).not.toThrow();
      expect(() => budget.check()).not.toThrow();
      expect(budget.snapshot().used).toBe(150);
    });
  });
});
