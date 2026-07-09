import { describe, expect, it } from "vitest";
import { ExecutionLoop } from "../src/execution-loop.js";
import { createMockHandlers } from "../src/handlers/mock.js";
import { InMemoryEventStore } from "../src/event-store/in-memory.js";
import { ExecutionContext } from "../src/execution-context.js";
import { createAgentConfig } from "../src/types/config.js";
import type { AgentInput } from "../src/types/agent.js";

describe("ExecutionLoop", () => {
  const config = createAgentConfig({ name: "test", maxSteps: 1 });
  const handlers = createMockHandlers();
  const eventStore = new InMemoryEventStore();

  function makeCtx(agentId = "test-agent") {
    return new ExecutionContext({
      agentId,
      config,
      state: "running",
    });
  }

  it("runs one full PRAO cycle producing 4 steps", async () => {
    const loop = new ExecutionLoop(handlers, eventStore, config);
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
    const loop = new ExecutionLoop(handlers, store, config);
    const agentId = "store-test";
    const input: AgentInput = { prompt: "hello" };
    await loop.run(input, makeCtx(agentId));

    const records = await store.getAll(agentId);
    expect(records).toHaveLength(4);
    expect(records.map((r) => r.type)).toEqual(["perceive", "reason", "act", "observe"]);
  });

  it("respects maxSteps to limit cycles", async () => {
    const twoStepConfig = createAgentConfig({ name: "test", maxSteps: 2 });
    const store = new InMemoryEventStore();
    const loop = new ExecutionLoop(handlers, store, twoStepConfig);
    const agentId = "maxsteps-test";
    const input: AgentInput = { prompt: "hello" };
    await loop.run(input, makeCtx(agentId));

    const records = await store.getAll(agentId);
    expect(records).toHaveLength(8); // 2 cycles * 4 steps
  });

  it("returns AgentOutput with content and steps", async () => {
    const loop = new ExecutionLoop(handlers, new InMemoryEventStore(), config);
    const input: AgentInput = { prompt: "hello" };
    const result = await loop.run(input, makeCtx());

    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("steps");
    expect(result).toHaveProperty("metadata");
    expect(typeof result.content).toBe("string");
    expect(result.content).toBe("hello");
    expect(Array.isArray(result.steps)).toBe(true);
  });
});
