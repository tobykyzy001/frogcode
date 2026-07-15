import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent.js";
import { AgentAbortedError } from "../src/execution-loop.js";
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

  it("transitions to running then finished on run()", async () => {
    const agent = Agent.create({ name: "test", eventsBasePath: tempDir });
    expect(agent.state).toBe("idle");
    const result = await agent.run({ prompt: "hello" });
    expect(agent.state).toBe("finished");
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
    expect(agent.state).toBe("finished");
    await expect(agent.run({ prompt: "again" })).rejects.toThrow(
      "Cannot run from state: finished",
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
});

describe("Agent reset", () => {
  it("reset() transitions from finished to idle", async () => {
    const agent = Agent.create({ name: "test", eventsBasePath: tempDir });
    await agent.run({ prompt: "first" });
    expect(agent.state).toBe("finished");

    agent.reset();
    expect(agent.state).toBe("idle");
  });

  it("reset() allows re-running the agent", async () => {
    const agent = Agent.create({ name: "test", eventsBasePath: tempDir });
    await agent.run({ prompt: "first" });
    expect(agent.state).toBe("finished");

    agent.reset();
    expect(agent.state).toBe("idle");

    const result = await agent.run({ prompt: "second" });
    expect(agent.state).toBe("finished");
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

  it("run() throws when agent is in failed state (must reset first)", async () => {
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

    await expect(agent.run({ prompt: "test" })).rejects.toThrow("perceive failed");
    expect(agent.state).toBe("failed");

    await expect(agent.run({ prompt: "again" })).rejects.toThrow(
      "Cannot run from state: failed",
    );
  });
});
