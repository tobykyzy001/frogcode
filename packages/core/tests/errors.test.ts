import { describe, expect, it } from "vitest";
import {
  AgentAbortedError,
  NoExecutionToResumeError,
  StepTimeoutError,
} from "../src/execution-loop.js";
import { isRetryableError } from "../src/errors.js";
import { InvalidStateTransitionError } from "../src/state-machine.js";
import type { AgentState } from "../src/types/agent.js";
import type { StepType } from "../src/types/step-record.js";

describe("isRetryableError", () => {
  describe("non-retryable built-in JS errors (programming errors)", () => {
    it("returns false for TypeError", () => {
      expect(isRetryableError(new TypeError("t"), 1)).toBe(false);
    });

    it("returns false for ReferenceError", () => {
      expect(isRetryableError(new ReferenceError("r"), 1)).toBe(false);
    });

    it("returns false for SyntaxError", () => {
      expect(isRetryableError(new SyntaxError("s"), 1)).toBe(false);
    });

    it("returns false for RangeError", () => {
      expect(isRetryableError(new RangeError("ra"), 1)).toBe(false);
    });
  });

  describe("non-retryable framework errors (control flow / logic)", () => {
    it("returns false for AgentAbortedError", () => {
      expect(isRetryableError(new AgentAbortedError(), 1)).toBe(false);
    });

    it("returns false for NoExecutionToResumeError", () => {
      expect(isRetryableError(new NoExecutionToResumeError(), 1)).toBe(false);
    });

    it("returns false for InvalidStateTransitionError", () => {
      const from: AgentState = "idle";
      const to: AgentState = "completed";
      expect(
        isRetryableError(new InvalidStateTransitionError(from, to), 1),
      ).toBe(false);
    });
  });

  describe("StepTimeoutError — retryable only on first attempt", () => {
    const stepType: StepType = "act";

    it("returns true on attempt=1 (occasional timeout)", () => {
      expect(
        isRetryableError(new StepTimeoutError(stepType, 50), 1),
      ).toBe(true);
    });

    it("returns false on attempt=2 (persistent timeout)", () => {
      expect(
        isRetryableError(new StepTimeoutError(stepType, 50), 2),
      ).toBe(false);
    });

    it("returns false on attempt=3 (persistent timeout)", () => {
      expect(
        isRetryableError(new StepTimeoutError(stepType, 50), 3),
      ).toBe(false);
    });
  });

  describe("generic Error — retryable by default", () => {
    it("returns true for generic Error on attempt 1", () => {
      expect(isRetryableError(new Error("boom"), 1)).toBe(true);
    });

    it("returns true for generic Error on any attempt", () => {
      expect(isRetryableError(new Error("boom"), 5)).toBe(true);
    });
  });

  describe("non-Error values — treated as retryable", () => {
    it("returns true for a string", () => {
      expect(isRetryableError("string error", 1)).toBe(true);
    });

    it("returns true for undefined", () => {
      expect(isRetryableError(undefined, 1)).toBe(true);
    });

    it("returns true for null", () => {
      expect(isRetryableError(null, 1)).toBe(true);
    });

    it("returns true for a plain object", () => {
      expect(isRetryableError({ code: 42 }, 1)).toBe(true);
    });
  });
});
