import { describe, expect, it } from "vitest";
import {
  AgentAbortedError,
  ExecutionLoop,
  StepTimeoutError,
} from "../src/execution-loop.js";
import { createMockHandlers } from "../src/handlers/mock.js";
import { InMemoryEventStore } from "../src/event-store/in-memory.js";
import { ExecutionContext } from "../src/execution-context.js";
import { AgentStateMachine } from "../src/state-machine.js";
import { createAgentConfig } from "../src/types/config.js";
import type { AgentInput } from "../src/types/agent.js";
import type { PRAOHandlers } from "../src/handlers/types.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ExecutionLoop", () => {
  const config = createAgentConfig({ name: "test", maxSteps: 1 });
  const handlers = createMockHandlers();

  function makeStateMachine() {
    const sm = new AgentStateMachine();
    sm.transition("running");
    return sm;
  }

  function makeCtx(agentId = "test-agent", sm?: AgentStateMachine) {
    return new ExecutionContext({
      agentId,
      config,
      stateMachine: sm ?? makeStateMachine(),
    });
  }

  it("runs one full PRAO cycle producing 4 steps", async () => {
    const loop = new ExecutionLoop(
      handlers,
      new InMemoryEventStore(),
      config,
      makeStateMachine(),
    );
    const input: AgentInput = { prompt: "hello" };
    const result = await loop.run(input, makeCtx());

    expect(result.steps).toHaveLength(4);
    expect(result.steps[0].type).toBe("perceive");
    expect(result.steps[1].type).toBe("reason");
    expect(result.steps[2].type).toBe("act");
    expect(result.steps[3].type).toBe("observe");
  });

  it("appends steps to EventStore", async () => {
    const store = new InMemoryEventStore();
    const loop = new ExecutionLoop(
      handlers,
      store,
      config,
      makeStateMachine(),
    );
    const agentId = "store-test";
    const input: AgentInput = { prompt: "hello" };
    await loop.run(input, makeCtx(agentId));

    const records = await store.getAll(agentId);
    expect(records).toHaveLength(4);
    expect(records.map((r) => r.type)).toEqual([
      "perceive",
      "reason",
      "act",
      "observe",
    ]);
  });

  it("done signal stops loop before maxSteps", async () => {
    const twoStepConfig = createAgentConfig({ name: "test", maxSteps: 5 });
    const store = new InMemoryEventStore();
    const loop = new ExecutionLoop(
      handlers,
      store,
      twoStepConfig,
      makeStateMachine(),
    );
    const agentId = "done-test";
    const input: AgentInput = { prompt: "hello" };
    await loop.run(input, makeCtx(agentId));

    const records = await store.getAll(agentId);
    expect(records).toHaveLength(4);
  });

  it("runs until maxSteps when done is never signaled", async () => {
    const noDoneHandlers: PRAOHandlers = {
      perceive: {
        async perceive(input: AgentInput) {
          return { rawInput: input.prompt };
        },
      },
      reason: {
        async reason(p: unknown) {
          return {
            action: { target: (p as { rawInput: string }).rawInput },
          };
        },
      },
      act: {
        async act(d: unknown) {
          return { result: (d as { target: string }).target };
        },
      },
      observe: {
        async observe(_a: unknown, r: unknown) {
          return { content: (r as { result: string }).result };
        },
      },
    };
    const twoStepConfig = createAgentConfig({ name: "test", maxSteps: 2 });
    const store = new InMemoryEventStore();
    const loop = new ExecutionLoop(
      noDoneHandlers,
      store,
      twoStepConfig,
      makeStateMachine(),
    );
    const agentId = "maxsteps-test";
    const input: AgentInput = { prompt: "hello" };
    await loop.run(input, makeCtx(agentId));

    const records = await store.getAll(agentId);
    expect(records).toHaveLength(8);
  });

  it("returns AgentOutput with steps containing observe content", async () => {
    const loop = new ExecutionLoop(
      handlers,
      new InMemoryEventStore(),
      config,
      makeStateMachine(),
    );
    const input: AgentInput = { prompt: "hello" };
    const result = await loop.run(input, makeCtx());

    expect(result).toHaveProperty("steps");
    expect(Array.isArray(result.steps)).toBe(true);
    const observeStep = result.steps.find((s) => s.type === "observe");
    expect(observeStep).toBeDefined();
    const observeResult = observeStep?.output as { content: string };
    expect(typeof observeResult.content).toBe("string");
    expect(observeResult.content).toBe("hello");
  });

  it("measures step duration (not zero)", async () => {
    const slowHandlers: PRAOHandlers = {
      perceive: {
        async perceive(input: AgentInput) {
          await delay(20);
          return { rawInput: input.prompt };
        },
      },
      reason: {
        async reason() {
          await delay(20);
          return { action: "test", done: true };
        },
      },
      act: {
        async act() {
          await delay(20);
          return { result: "done" };
        },
      },
      observe: {
        async observe() {
          await delay(20);
          return { content: "observed" };
        },
      },
    };
    const loop = new ExecutionLoop(
      slowHandlers,
      new InMemoryEventStore(),
      config,
      makeStateMachine(),
    );
    const result = await loop.run({ prompt: "test" }, makeCtx());

    for (const step of result.steps) {
      expect(step.duration).toBeGreaterThan(0);
    }
  });

  it("records failed steps with error metadata before throwing", async () => {
    const failingHandlers: PRAOHandlers = {
      perceive: {
        async perceive(input: AgentInput) {
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
          throw new Error("act failed");
        },
      },
      observe: {
        async observe() {
          return { content: "never" };
        },
      },
    };
    const noRetryConfig = createAgentConfig({
      name: "test",
      maxSteps: 1,
      maxRetries: 0,
    });
    const store = new InMemoryEventStore();
    const agentId = "fail-test";
    const loop = new ExecutionLoop(
      failingHandlers,
      store,
      noRetryConfig,
      makeStateMachine(),
    );
    await expect(
      loop.run({ prompt: "test" }, makeCtx(agentId)),
    ).rejects.toThrow("act failed");

    const records = await store.getAll(agentId);
    const failedStep = records.find((r) => r.metadata.status === "failed");
    expect(failedStep).toBeDefined();
    expect(failedStep?.type).toBe("act");
    expect(failedStep?.metadata.error).toBe("act failed");
    expect(failedStep?.metadata.errorName).toBe("Error");
  });

  it("retries failed handler up to maxRetries then succeeds", async () => {
    let calls = 0;
    const flakyHandlers: PRAOHandlers = {
      perceive: {
        async perceive(input: AgentInput) {
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
          calls++;
          if (calls < 2) throw new Error("flaky failure");
          return { result: "success" };
        },
      },
      observe: {
        async observe() {
          return { content: "observed" };
        },
      },
    };
    const retryConfig = createAgentConfig({
      name: "test",
      maxSteps: 1,
      maxRetries: 3,
    });
    const loop = new ExecutionLoop(
      flakyHandlers,
      new InMemoryEventStore(),
      retryConfig,
      makeStateMachine(),
    );
    const result = await loop.run({ prompt: "test" }, makeCtx());

    const actStep = result.steps.find((s) => s.type === "act");
    expect(actStep?.metadata.attempt).toBe(2);
    expect(actStep?.metadata.status).toBe("completed");
  });

  it("throws after maxRetries exhausted", async () => {
    const alwaysFailHandlers: PRAOHandlers = {
      perceive: {
        async perceive(input: AgentInput) {
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
          throw new Error("always fails");
        },
      },
      observe: {
        async observe() {
          return { content: "never" };
        },
      },
    };
    const retryConfig = createAgentConfig({
      name: "test",
      maxSteps: 1,
      maxRetries: 2,
    });
    const store = new InMemoryEventStore();
    const loop = new ExecutionLoop(
      alwaysFailHandlers,
      store,
      retryConfig,
      makeStateMachine(),
    );
    await expect(
      loop.run({ prompt: "test" }, makeCtx()),
    ).rejects.toThrow("always fails");

    const records = await store.getAll("test-agent");
    const failedStep = records.find((r) => r.metadata.status === "failed");
    expect(failedStep?.metadata.attempt).toBe(3);
  });

  it("pauses on failure when pauseOnFailure is true, throws original error", async () => {
    const failingHandlers: PRAOHandlers = {
      perceive: {
        async perceive(input: AgentInput) {
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
          throw new Error("act failed");
        },
      },
      observe: {
        async observe() {
          return { content: "never" };
        },
      },
    };
    const pauseConfig = createAgentConfig({
      name: "test",
      maxSteps: 1,
      maxRetries: 0,
      pauseOnFailure: true,
    });
    const sm = makeStateMachine();
    const store = new InMemoryEventStore();
    const loop = new ExecutionLoop(
      failingHandlers,
      store,
      pauseConfig,
      sm,
    );
    await expect(
      loop.run({ prompt: "test" }, makeCtx("pause-fail", sm)),
    ).rejects.toThrow("act failed");

    expect(sm.state).toBe("paused");

    const records = await store.getAll("pause-fail");
    const failedStep = records.find((r) => r.metadata.status === "failed");
    expect(failedStep).toBeDefined();
    expect(failedStep?.type).toBe("act");
  });

  it("throws StepTimeoutError when handler exceeds stepTimeoutMs", async () => {
    const slowHandlers: PRAOHandlers = {
      perceive: {
        async perceive(input: AgentInput) {
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
      new InMemoryEventStore(),
      timeoutConfig,
      makeStateMachine(),
    );
    await expect(
      loop.run({ prompt: "test" }, makeCtx()),
    ).rejects.toThrow(StepTimeoutError);
  });

  it("checks pause between each step (not just at cycle start)", async () => {
    const sm = makeStateMachine();
    const pausingHandlers: PRAOHandlers = {
      perceive: {
        async perceive(input: AgentInput) {
          return { rawInput: input.prompt };
        },
      },
      reason: {
        async reason() {
          sm.transition("paused");
          return { action: "test", done: false };
        },
      },
      act: {
        async act() {
          throw new Error("act should not be called");
        },
      },
      observe: {
        async observe() {
          throw new Error("observe should not be called");
        },
      },
    };
    const loop = new ExecutionLoop(
      pausingHandlers,
      new InMemoryEventStore(),
      config,
      sm,
    );
    // Paused before observe — returns steps, state is paused (no error to propagate)
    const result = await loop.run(
      { prompt: "test" },
      makeCtx("inter-step", sm),
    );

    expect(sm.state).toBe("paused");
    expect(result.steps).toHaveLength(2);
  });

  it("stops immediately when aborted during execution", async () => {
    const sm = makeStateMachine();
    let perceiveCalls = 0;
    const abortingHandlers: PRAOHandlers = {
      perceive: {
        async perceive(input: AgentInput) {
          perceiveCalls++;
          if (perceiveCalls === 2) sm.transition("aborted");
          return { rawInput: input.prompt };
        },
      },
      reason: {
        async reason() {
          return { action: "test" };
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
    const config3 = createAgentConfig({ name: "test", maxSteps: 3 });
    const store = new InMemoryEventStore();
    const loop = new ExecutionLoop(
      abortingHandlers,
      store,
      config3,
      sm,
    );
    await expect(
      loop.run({ prompt: "test" }, makeCtx("abort-test", sm)),
    ).rejects.toThrow(AgentAbortedError);

    expect(sm.state).toBe("aborted");
    const records = await store.getAll("abort-test");
    expect(records).toHaveLength(5);
  });

  it("resume() continues execution from where it paused", async () => {
    const sm = makeStateMachine();
    let perceiveCalls = 0;
    const pausingHandlers: PRAOHandlers = {
      perceive: {
        async perceive(input: AgentInput) {
          perceiveCalls++;
          if (perceiveCalls === 2) sm.transition("paused");
          return { rawInput: input.prompt };
        },
      },
      reason: {
        async reason(p: unknown) {
          return {
            action: { target: (p as { rawInput: string }).rawInput },
            done: perceiveCalls >= 3,
          };
        },
      },
      act: {
        async act(d: unknown) {
          return { result: (d as { target: string }).target };
        },
      },
      observe: {
        async observe(_a: unknown, r: unknown) {
          return { content: (r as { result: string }).result };
        },
      },
    };
    const config3 = createAgentConfig({ name: "test", maxSteps: 3 });
    const loop = new ExecutionLoop(
      pausingHandlers,
      new InMemoryEventStore(),
      config3,
      sm,
    );

    const result1 = await loop.run(
      { prompt: "test" },
      makeCtx("resume-test", sm),
    );
    expect(result1.steps).toHaveLength(5);
    expect(sm.state).toBe("paused");

    sm.transition("running");
    const result2 = await loop.resume();
    expect(result2.steps).toHaveLength(12);
  });

  it("resume() throws when no previous execution exists", async () => {
    const loop = new ExecutionLoop(
      handlers,
      new InMemoryEventStore(),
      config,
      makeStateMachine(),
    );
    await expect(loop.resume()).rejects.toThrow(
      "Cannot resume: no previous execution to continue",
    );
  });

  it("stores ObserveResult in observe step output", async () => {
    const customObserveHandlers: PRAOHandlers = {
      perceive: {
        async perceive(input: AgentInput) {
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
          return {
            content: "custom observation text",
            data: { extra: "info" },
          };
        },
      },
    };
    const loop = new ExecutionLoop(
      customObserveHandlers,
      new InMemoryEventStore(),
      config,
      makeStateMachine(),
    );
    const result = await loop.run({ prompt: "test" }, makeCtx());

    const observeStep = result.steps.find((s) => s.type === "observe");
    expect(observeStep).toBeDefined();
    const observeResult = observeStep?.output as {
      content: string;
      data: unknown;
    };
    expect(observeResult.content).toBe("custom observation text");
    expect(observeResult.data).toEqual({ extra: "info" });
  });

  it("generates unique step IDs using UUID", async () => {
    const loop = new ExecutionLoop(
      handlers,
      new InMemoryEventStore(),
      config,
      makeStateMachine(),
    );
    const result = await loop.run({ prompt: "test" }, makeCtx());

    const ids = result.steps.map((s) => s.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^step-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });
});
