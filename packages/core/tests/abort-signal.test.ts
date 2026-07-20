import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isRetryExhausted, isRetryableError } from "../src/errors.js";
import type { RetryExhaustedMarker } from "../src/errors.js";
import { FileEventStore } from "../src/event-store/file.js";
import { ExecutionContext } from "../src/execution-context.js";
import {
  AgentAbortedError,
  ExecutionLoop,
  StepTimeoutError,
} from "../src/execution-loop.js";
import type { PRAOHandlers } from "../src/handlers/types.js";
import { AgentStateMachine } from "../src/state-machine.js";
import type { AgentInput } from "../src/types/agent.js";
import { createAgentConfig } from "../src/types/config.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeConfig(name = "test-agent") {
  return createAgentConfig({ name });
}

function makeStateMachine() {
  const sm = new AgentStateMachine();
  sm.transition("running");
  return sm;
}

describe("ExecutionContext.withSignal", () => {
  it("default signal in constructor is a non-aborted AbortSignal", () => {
    const ctx = new ExecutionContext({
      agentId: "agent-1",
      config: makeConfig(),
      stateMachine: makeStateMachine(),
    });
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
    expect(ctx.signal.aborted).toBe(false);
  });

  it("constructor accepts a custom signal", () => {
    const ac = new AbortController();
    const ctx = new ExecutionContext({
      agentId: "agent-1",
      config: makeConfig(),
      stateMachine: makeStateMachine(),
      signal: ac.signal,
    });
    expect(ctx.signal).toBe(ac.signal);
  });

  it("returns a new context (not the same reference)", () => {
    const ctx = new ExecutionContext({
      agentId: "agent-1",
      config: makeConfig(),
      stateMachine: makeStateMachine(),
    });
    const newSignal = new AbortController().signal;
    const child = ctx.withSignal(newSignal);
    expect(child).not.toBe(ctx);
  });

  it("replaces the signal with the provided one", () => {
    const ctx = new ExecutionContext({
      agentId: "agent-1",
      config: makeConfig(),
      stateMachine: makeStateMachine(),
    });
    const newSignal = new AbortController().signal;
    const child = ctx.withSignal(newSignal);
    expect(child.signal).toBe(newSignal);
  });

  it("preserves agentId and config (shallow copy)", () => {
    const config = makeConfig("preserved");
    const sm = makeStateMachine();
    const ctx = new ExecutionContext({
      agentId: "agent-x",
      config,
      stateMachine: sm,
    });
    const child = ctx.withSignal(new AbortController().signal);
    expect(child.agentId).toBe("agent-x");
    expect(child.config).toBe(config);
    expect(child.state).toBe("running");
  });

  it("inherits metadata via spread (not shared reference)", () => {
    const ctx = new ExecutionContext({
      agentId: "agent-1",
      config: makeConfig(),
      stateMachine: makeStateMachine(),
      metadata: { foo: "bar", count: 1 },
    });
    const child = ctx.withSignal(new AbortController().signal);
    expect(child.metadata).toEqual({ foo: "bar", count: 1 });
    expect(child.metadata).not.toBe(ctx.metadata);
  });

  it("does not set parent (shallow copy, not createChild)", () => {
    const ctx = new ExecutionContext({
      agentId: "agent-1",
      config: makeConfig(),
      stateMachine: makeStateMachine(),
    });
    const child = ctx.withSignal(new AbortController().signal);
    expect(child.parent).toBeUndefined();
  });
});

describe("Per-step AbortController in ExecutionLoop", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "frogcode-abort-"));
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = "" as string;
    }
  });

  function makeCtx(agentId = "test-agent", signal?: AbortSignal) {
    const opts: ConstructorParameters<typeof ExecutionContext>[0] = {
      agentId,
      config: makeConfig(),
      stateMachine: makeStateMachine(),
    };
    if (signal !== undefined) {
      opts.signal = signal;
    }
    return new ExecutionContext(opts);
  }

  it("per-step timeout aborts handler via step controller and throws StepTimeoutError", async () => {
    let capturedSignal: AbortSignal | undefined;
    const slowHandlers: PRAOHandlers = {
      perceive: {
        async perceive(input: AgentInput, ctx) {
          capturedSignal = ctx.signal;
          await delay(1000);
          return { rawInput: input.prompt };
        },
      },
      reason: {
        async reason() {
          return { action: "test", done: true };
        },
      },
      act: {
        async act() {
          return { result: "done" };
        },
      },
      observe: {
        async observe() {
          return { content: "observed" };
        },
      },
    };
    const timeoutConfig = createAgentConfig({
      name: "test",
      maxSteps: 1,
      stepTimeoutMs: 50,
      maxRetries: 0,
    });
    const loop = new ExecutionLoop(
      slowHandlers,
      new FileEventStore(tempDir),
      timeoutConfig,
      makeStateMachine(),
    );
    await expect(loop.run({ prompt: "test" }, makeCtx())).rejects.toThrow(
      StepTimeoutError,
    );

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(true);
    expect(capturedSignal?.reason).toBeInstanceOf(StepTimeoutError);
  });

  it("agent-level abort propagates to step controller when aborted mid-step", async () => {
    const ac = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const slowHandlers: PRAOHandlers = {
      perceive: {
        async perceive(input: AgentInput, ctx) {
          capturedSignal = ctx.signal;
          // Wait long enough for the test to trigger abort
          await delay(500);
          return { rawInput: input.prompt };
        },
      },
      reason: {
        async reason() {
          return { action: "test", done: true };
        },
      },
      act: {
        async act() {
          return { result: "done" };
        },
      },
      observe: {
        async observe() {
          return { content: "observed" };
        },
      },
    };
    const noTimeoutConfig = createAgentConfig({
      name: "test",
      maxSteps: 1,
      stepTimeoutMs: 0,
      maxRetries: 0,
    });
    const loop = new ExecutionLoop(
      slowHandlers,
      new FileEventStore(tempDir),
      noTimeoutConfig,
      makeStateMachine(),
    );
    const ctx = makeCtx("abort-mid-step", ac.signal);

    // Trigger abort shortly after the handler starts
    setTimeout(() => ac.abort(new AgentAbortedError()), 50);

    await expect(loop.run({ prompt: "test" }, ctx)).rejects.toThrow(
      AgentAbortedError,
    );

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(true);
    expect(capturedSignal?.reason).toBeInstanceOf(AgentAbortedError);
  });

  it("agent-level pre-aborted signal causes step to reject immediately", async () => {
    const ac = new AbortController();
    ac.abort(new AgentAbortedError());

    const failingHandlers: PRAOHandlers = {
      perceive: {
        async perceive() {
          throw new Error("perceive should not run when pre-aborted");
        },
      },
      reason: {
        async reason() {
          throw new Error("reason should not run");
        },
      },
      act: {
        async act() {
          throw new Error("act should not run");
        },
      },
      observe: {
        async observe() {
          throw new Error("observe should not run");
        },
      },
    };
    const noTimeoutConfig = createAgentConfig({
      name: "test",
      maxSteps: 1,
      stepTimeoutMs: 0,
      maxRetries: 0,
    });
    const loop = new ExecutionLoop(
      failingHandlers,
      new FileEventStore(tempDir),
      noTimeoutConfig,
      makeStateMachine(),
    );
    const ctx = makeCtx("pre-aborted", ac.signal);

    await expect(loop.run({ prompt: "test" }, ctx)).rejects.toThrow(
      AgentAbortedError,
    );
  });

  it("handler can observe ctx.signal and exit early when aborted", async () => {
    const ac = new AbortController();
    let observedAbort = false;
    const slowHandlers: PRAOHandlers = {
      perceive: {
        async perceive(input: AgentInput, ctx) {
          // Handler that polls ctx.signal and exits when aborted
          await new Promise<void>((resolve) => {
            ctx.signal.addEventListener("abort", () => {
              observedAbort = true;
              resolve();
            });
          });
          return { rawInput: input.prompt };
        },
      },
      reason: {
        async reason() {
          return { action: "test", done: true };
        },
      },
      act: {
        async act() {
          return { result: "done" };
        },
      },
      observe: {
        async observe() {
          return { content: "observed" };
        },
      },
    };
    const noTimeoutConfig = createAgentConfig({
      name: "test",
      maxSteps: 1,
      stepTimeoutMs: 0,
      maxRetries: 0,
    });
    const loop = new ExecutionLoop(
      slowHandlers,
      new FileEventStore(tempDir),
      noTimeoutConfig,
      makeStateMachine(),
    );
    const ctx = makeCtx("observe-abort", ac.signal);

    setTimeout(() => ac.abort(new AgentAbortedError()), 50);

    await expect(loop.run({ prompt: "test" }, ctx)).rejects.toThrow(
      AgentAbortedError,
    );
    expect(observedAbort).toBe(true);
  });
});

describe("RetryExhausted marker", () => {
  it("isRetryExhausted returns true for plain objects with retryExhausted: true", () => {
    const marker: RetryExhaustedMarker = { retryExhausted: true };
    expect(isRetryExhausted(marker)).toBe(true);
  });

  it("isRetryExhausted returns true for Error with retryExhausted: true", () => {
    const err = Object.assign(new Error("exhausted"), {
      retryExhausted: true,
    } satisfies RetryExhaustedMarker);
    expect(isRetryExhausted(err)).toBe(true);
  });

  it("isRetryExhausted returns false for null/undefined/primitives", () => {
    expect(isRetryExhausted(null)).toBe(false);
    expect(isRetryExhausted(undefined)).toBe(false);
    expect(isRetryExhausted("string")).toBe(false);
    expect(isRetryExhausted(123)).toBe(false);
    expect(isRetryExhausted(true)).toBe(false);
  });

  it("isRetryExhausted returns false for objects without the marker", () => {
    expect(isRetryExhausted({})).toBe(false);
    expect(isRetryExhausted({ retryExhausted: false })).toBe(false);
    expect(isRetryExhausted({ retryExhausted: "yes" })).toBe(false);
    expect(isRetryExhausted(new Error("plain"))).toBe(false);
  });

  it("isRetryableError returns false for RetryExhausted marker", () => {
    const marker: RetryExhaustedMarker = { retryExhausted: true };
    expect(isRetryableError(marker, 1)).toBe(false);
    expect(isRetryableError(marker, 5)).toBe(false);
  });

  it("isRetryableError returns false for Error carrying retryExhausted: true", () => {
    const exhausted = Object.assign(new Error("retries exhausted"), {
      retryExhausted: true,
    } satisfies RetryExhaustedMarker);
    expect(isRetryableError(exhausted, 1)).toBe(false);
  });

  it("isRetryableError still classifies StepTimeoutError as retryable on attempt 1 (marker absent)", () => {
    const stepType = "act";
    const timeout = new StepTimeoutError(stepType, 50);
    expect(isRetryableError(timeout, 1)).toBe(true);
  });

  it("isRetryableError returns false for plain Error (unchanged behavior)", () => {
    expect(isRetryableError(new Error("boom"), 1)).toBe(false);
  });
});
