import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import { InvalidStateTransitionError } from "../src/state-machine.js";
import { InMemoryEventStore } from "../src/event-store/in-memory.js";

describe("Agent", () => {
  it("starts in idle state", () => {
    const agent = Agent.create({ name: "test" });
    expect(agent.state).toBe("idle");
  });

  it("transitions to running then completed on run()", async () => {
    const agent = Agent.create({ name: "test" });
    expect(agent.state).toBe("idle");
    const result = await agent.run({ prompt: "hello" });
    expect(agent.state).toBe("completed");
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("steps");
  });

  it("returns AgentOutput with content and steps", async () => {
    const agent = Agent.create({ name: "test" });
    const result = await agent.run({ prompt: "hello world" });
    expect(result.content).toBe("hello world");
    expect(result.steps.length).toBeGreaterThan(0);
  });

  it("produces steps with correct type sequence", async () => {
    const agent = Agent.create({ name: "test", maxSteps: 1 });
    const result = await agent.run({ prompt: "test" });
    const types = result.steps.map((s) => s.type);
    expect(types).toEqual(["perceive", "reason", "act", "observe"]);
  });

  it("serializes and deserializes StepRecord", async () => {
    const agent = Agent.create({ name: "test", maxSteps: 1 });
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
    const agent = Agent.create({ name: "test" });
    expect(() => agent.pause()).toThrow(InvalidStateTransitionError);
  });

  it("Agent.create() factory method works", () => {
    const agent = Agent.create({ name: "factory-test" });
    expect(agent.config.name).toBe("factory-test");
    expect(agent.state).toBe("idle");
  });

  it("respects maxSteps to limit execution", async () => {
    const agent = Agent.create({ name: "test", maxSteps: 2 });
    const result = await agent.run({ prompt: "test" });
    expect(result.steps).toHaveLength(8); // 2 cycles * 4 steps
  });

  it("records steps in shared EventStore", async () => {
    const eventStore = new InMemoryEventStore();
    const agent = new Agent({
      id: "event-test",
      config: { name: "test", maxSteps: 1, stepTimeoutMs: 30000, maxRetries: 3, pauseOnFailure: false, metadata: {} },
      eventStore,
    });
    await agent.run({ prompt: "test" });
    const records = await eventStore.getAll("event-test");
    expect(records).toHaveLength(4);
  });
});
