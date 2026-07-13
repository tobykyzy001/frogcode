import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent.js";
import { AgentAbortedError } from "../src/execution-loop.js";
import { InvalidStateTransitionError } from "../src/state-machine.js";
import { FileEventStore } from "../src/event-store/file.js";
import { createMockHandlers } from "../src/handlers/mock.js";
import { createAgentConfig } from "../src/types/config.js";
import type { AgentInput } from "../src/types/agent.js";
import type { PRAOHandlers } from "../src/handlers/types.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "frogcode-test-"));
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = "" as string;
  }
});

describe("Agent", () => {
  it("starts in idle state", () => {
    const agent = Agent.create({ name: "test", eventsBasePath: tempDir });
    expect(agent.state).toBe("idle");
  });

  it("transitions to running then completed on run()", async () => {
    const agent = Agent.create({ name: "test", eventsBasePath: tempDir });
    expect(agent.state).toBe("idle");
    const result = await agent.run({ prompt: "hello" });
    expect(agent.state).toBe("completed");
    expect(result).toHaveProperty("steps");
  });

  it("returns AgentOutput with steps containing observe result", async () => {
    const agent = Agent.create({ name: "test", eventsBasePath: tempDir });
    const result = await agent.run({ prompt: "hello world" });
    const observeStep = result.steps.find((s) => s.type === "observe");
    expect(observeStep).toBeDefined();
    const observeResult = observeStep?.output as { content: string };
    expect(observeResult.content).toBe("hello world");
    expect(result.steps.length).toBeGreaterThan(0);
  });

  it("produces steps with correct type sequence", async () => {
    const agent = Agent.create({
      name: "test",
      maxSteps: 1,
      eventsBasePath: tempDir,
    });
    const result = await agent.run({ prompt: "test" });
    const types = result.steps.map((s) => s.type);
    expect(types).toEqual(["perceive", "reason", "act", "observe"]);
  });

  it("serializes and deserializes StepRecord", async () => {
    const agent = Agent.create({
      name: "test",
      maxSteps: 1,
      eventsBasePath: tempDir,
    });
    const result = await agent.run({ prompt: "test" });
    for (const step of result.steps) {
      const serialized = JSON.stringify(step);
      const parsed = JSON.parse(serialized);
      expect(parsed.id).toBe(step.id);
      expect(parsed.type).toBe(step.type);
      expect(parsed.agentId).toBe(step.agentId);
    }
  });

  it("throws InvalidStateTransitionError on pause() from idle", () => {
    const agent = Agent.create({ name: "test", eventsBasePath: tempDir });
    expect(() => agent.pause()).toThrow(InvalidStateTransitionError);
  });

  it("Agent.create() factory method works", () => {
    const agent = Agent.create({ name: "factory-test", eventsBasePath: tempDir });
    expect(agent.config.name).toBe("factory-test");
    expect(agent.state).toBe("idle");
  });

  it("done signal overrides maxSteps", async () => {
    const agent = Agent.create({
      name: "test",
      maxSteps: 10,
      eventsBasePath: tempDir,
    });
    const result = await agent.run({ prompt: "test" });
    expect(result.steps).toHaveLength(4);
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
    const agent = Agent.create({
      name: "test",
      maxSteps: 2,
      handlers: noDoneHandlers,
      eventsBasePath: tempDir,
    });
    const result = await agent.run({ prompt: "test" });
    expect(result.steps).toHaveLength(8);
  });

  it("records steps in shared EventStore", async () => {
    const eventStore = new FileEventStore(tempDir);
    const agent = new Agent({
      id: "event-test",
      config: createAgentConfig({
        name: "test",
        maxSteps: 1,
        eventsBasePath: tempDir,
      }),
    });
    await agent.run({ prompt: "test" });
    const records = await eventStore.getAll("event-test");
    expect(records).toHaveLength(4);
  });

  it("Agent.create() accepts handlers and eventsBasePath", async () => {
    const handlers = createMockHandlers();
    const agent = Agent.create({
      name: "test",
      handlers,
      eventsBasePath: tempDir,
    });
    await agent.run({ prompt: "test" });
    const eventStore = new FileEventStore(tempDir);
    const records = await eventStore.getAll(agent.id);
    expect(records.length).toBeGreaterThan(0);
  });

  it("generates unique agent IDs using UUID", () => {
    const agent1 = Agent.create({ name: "test1", eventsBasePath: tempDir });
    const agent2 = Agent.create({ name: "test2", eventsBasePath: tempDir });
    expect(agent1.id).not.toBe(agent2.id);
    expect(agent1.id).toMatch(/^agent-[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("run() throws when agent is not idle", async () => {
    const agent = Agent.create({ name: "test", eventsBasePath: tempDir });
    await agent.run({ prompt: "first" });
    expect(agent.state).toBe("completed");
    await expect(agent.run({ prompt: "again" })).rejects.toThrow(
      "Cannot run from state: completed",
    );
  });
});

describe("Agent pause/resume during execution", () => {
  function createPausingHandlers(
    getAgent: () => Agent,
    pauseOnCall = 2,
  ): PRAOHandlers {
    let perceiveCalls = 0;
    return {
      perceive: {
        async perceive(input: AgentInput) {
          perceiveCalls++;
          if (perceiveCalls === pauseOnCall && getAgent().state === "running") {
            getAgent().pause();
          }
          return { rawInput: input.prompt };
        },
      },
      reason: {
        async reason(perception: unknown) {
          return {
            action: { target: (perception as { rawInput: string }).rawInput },
          };
        },
      },
      act: {
        async act(decision: unknown) {
          return { result: (decision as { target: string }).target };
        },
      },
      observe: {
        async observe(_action: unknown, result: unknown) {
          return { content: (result as { result: string }).result };
        },
      },
    };
  }

  it("pause() during execution stops immediately after current step", async () => {
    let agent: Agent;
    const handlers = createPausingHandlers(() => agent);
    agent = new Agent({
      id: "pause-during-run",
      config: createAgentConfig({
        name: "test",
        maxSteps: 3,
        eventsBasePath: tempDir,
      }),
      handlers,
    });

    const result = await agent.run({ prompt: "hello" });

    expect(agent.state).toBe("paused");
    // Cycle 1: 4 steps (perceive, reason, act, observe)
    // Cycle 2: 1 step (perceive triggers pause, loop breaks before reason)
    expect(result.steps).toHaveLength(5);
  });

  it("run() does not transition to completed when paused mid-execution", async () => {
    let agent: Agent;
    const handlers = createPausingHandlers(() => agent);
    agent = new Agent({
      id: "no-complete-on-pause",
      config: createAgentConfig({
        name: "test",
        maxSteps: 3,
        eventsBasePath: tempDir,
      }),
      handlers,
    });

    await agent.run({ prompt: "test" });

    expect(agent.state).toBe("paused");
    expect(agent.state).not.toBe("completed");
  });

  it("resume() continues execution and completes", async () => {
    let agent: Agent;
    const handlers = createPausingHandlers(() => agent);
    agent = new Agent({
      id: "resume-test",
      config: createAgentConfig({
        name: "test",
        maxSteps: 3,
        eventsBasePath: tempDir,
      }),
      handlers,
    });

    const result1 = await agent.run({ prompt: "test" });
    expect(agent.state).toBe("paused");
    expect(result1.steps).toHaveLength(5);

    const result2 = await agent.resume();
    expect(agent.state).toBe("completed");
    // 5 from run + 3 (reason, act, observe for cycle 1) + 4 (full cycle 2) = 12
    expect(result2.steps).toHaveLength(12);
  });

  it("resume() throws when agent is not paused", async () => {
    const agent = Agent.create({ name: "test", eventsBasePath: tempDir });
    await expect(agent.resume()).rejects.toThrow(
      "Cannot resume from state: idle",
    );
  });
});

describe("Agent abort", () => {
  function createAbortingHandlers(
    getAgent: () => Agent,
    abortOnCall = 2,
  ): PRAOHandlers {
    let perceiveCalls = 0;
    return {
      perceive: {
        async perceive(input: AgentInput) {
          perceiveCalls++;
          if (perceiveCalls === abortOnCall) {
            getAgent().abort();
          }
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
  }

  it("abort() during execution causes AgentAbortedError", async () => {
    let agent: Agent;
    const handlers = createAbortingHandlers(() => agent);
    agent = new Agent({
      id: "abort-test",
      config: createAgentConfig({
        name: "test",
        maxSteps: 3,
        eventsBasePath: tempDir,
      }),
      handlers,
    });

    await expect(agent.run({ prompt: "test" })).rejects.toThrow(
      AgentAbortedError,
    );
    expect(agent.state).toBe("aborted");
  });

  it("abort() from paused state transitions to aborted", async () => {
    let agent: Agent;
    let perceiveCalls = 0;
    const pausingHandlers: PRAOHandlers = {
      perceive: {
        async perceive(input: AgentInput) {
          perceiveCalls++;
          if (perceiveCalls === 2) agent.pause();
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
    agent = new Agent({
      id: "abort-from-paused",
      config: createAgentConfig({
        name: "test",
        maxSteps: 3,
        eventsBasePath: tempDir,
      }),
      handlers: pausingHandlers,
    });

    await agent.run({ prompt: "test" });
    expect(agent.state).toBe("paused");

    agent.abort();
    expect(agent.state).toBe("aborted");

    // resume() should throw since state is aborted, not paused
    await expect(agent.resume()).rejects.toThrow(
      "Cannot resume from state: aborted",
    );

    // reset should work from aborted
    agent.reset();
    expect(agent.state).toBe("idle");
  });
});

describe("Agent reset", () => {
  it("reset() transitions from completed to idle", async () => {
    const agent = Agent.create({ name: "test", eventsBasePath: tempDir });
    await agent.run({ prompt: "first" });
    expect(agent.state).toBe("completed");

    agent.reset();
    expect(agent.state).toBe("idle");
  });

  it("reset() allows re-running the agent", async () => {
    const agent = Agent.create({ name: "test", eventsBasePath: tempDir });
    await agent.run({ prompt: "first" });
    expect(agent.state).toBe("completed");

    agent.reset();
    expect(agent.state).toBe("idle");

    const result = await agent.run({ prompt: "second" });
    expect(agent.state).toBe("completed");
    expect(result.steps.length).toBeGreaterThan(0);
  });

  it("reset() transitions from failed to idle", async () => {
    const failingHandlers: PRAOHandlers = {
      perceive: {
        async perceive() {
          throw new Error("perceive failed");
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
    const agent = Agent.create({
      name: "test",
      maxRetries: 0,
      handlers: failingHandlers,
      eventsBasePath: tempDir,
    });

    await expect(agent.run({ prompt: "test" })).rejects.toThrow(
      "perceive failed",
    );
    expect(agent.state).toBe("failed");

    agent.reset();
    expect(agent.state).toBe("idle");
  });

  it("reset() transitions from aborted to idle", async () => {
    let agent: Agent;
    const abortingHandlers: PRAOHandlers = {
      perceive: {
        async perceive(input: AgentInput) {
          agent.abort();
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
    agent = new Agent({
      id: "reset-aborted",
      config: createAgentConfig({
        name: "test",
        maxSteps: 3,
        eventsBasePath: tempDir,
      }),
      handlers: abortingHandlers,
    });

    await expect(agent.run({ prompt: "test" })).rejects.toThrow(
      AgentAbortedError,
    );
    expect(agent.state).toBe("aborted");

    agent.reset();
    expect(agent.state).toBe("idle");
  });

  it("reset() throws when agent is not in terminal state", () => {
    const agent = Agent.create({ name: "test", eventsBasePath: tempDir });
    expect(() => agent.reset()).toThrow("Cannot reset from state: idle");
  });
});
