import { describe, it, expect } from "vitest";
import { ExecutionContext } from "../src/execution-context.js";
import { AgentStateMachine } from "../src/state-machine.js";
import { createAgentConfig } from "../src/types/config.js";

function makeConfig(name = "test-agent") {
  return createAgentConfig({ name });
}

function makeStateMachine() {
  return new AgentStateMachine();
}

describe("ExecutionContext", () => {
  it("creates context with required fields (agentId, config, stateMachine)", () => {
    const config = makeConfig();
    const sm = makeStateMachine();
    const ctx = new ExecutionContext({
      agentId: "agent-1",
      config,
      stateMachine: sm,
    });

    expect(ctx.agentId).toBe("agent-1");
    expect(ctx.config).toBe(config);
    expect(ctx.state).toBe("idle");
  });

  it("creates context with initial metadata", () => {
    const ctx = new ExecutionContext({
      agentId: "agent-1",
      config: makeConfig(),
      stateMachine: makeStateMachine(),
      metadata: { foo: "bar", count: 42 },
    });

    expect(ctx.metadata).toEqual({ foo: "bar", count: 42 });
    expect(ctx.get("foo")).toBe("bar");
    expect(ctx.get("count")).toBe(42);
  });

  it("defaults metadata to empty object when not provided", () => {
    const ctx = new ExecutionContext({
      agentId: "agent-1",
      config: makeConfig(),
      stateMachine: makeStateMachine(),
    });

    expect(ctx.metadata).toEqual({});
  });

  it("set() stores values retrievable via get()", () => {
    const ctx = new ExecutionContext({
      agentId: "agent-1",
      config: makeConfig(),
      stateMachine: makeStateMachine(),
    });

    ctx.set("greeting", "hello");
    ctx.set("count", 7);
    ctx.set("flag", true);

    expect(ctx.get("greeting")).toBe("hello");
    expect(ctx.get("count")).toBe(7);
    expect(ctx.get<boolean>("flag")).toBe(true);
  });

  it("set() overwrites existing values", () => {
    const ctx = new ExecutionContext({
      agentId: "agent-1",
      config: makeConfig(),
      stateMachine: makeStateMachine(),
      metadata: { key: "old" },
    });

    ctx.set("key", "new");
    expect(ctx.get("key")).toBe("new");
  });

  it("has() returns true for existing keys and false for missing", () => {
    const ctx = new ExecutionContext({
      agentId: "agent-1",
      config: makeConfig(),
      stateMachine: makeStateMachine(),
      metadata: { exists: 1 },
    });

    expect(ctx.has("exists")).toBe(true);
    expect(ctx.has("missing")).toBe(false);
  });

  it("has() returns true even when value is undefined", () => {
    const ctx = new ExecutionContext({
      agentId: "agent-1",
      config: makeConfig(),
      stateMachine: makeStateMachine(),
      metadata: { nullable: undefined },
    });

    expect(ctx.has("nullable")).toBe(true);
    expect(ctx.get("nullable")).toBeUndefined();
  });

  it("get() returns undefined for missing keys", () => {
    const ctx = new ExecutionContext({
      agentId: "agent-1",
      config: makeConfig(),
      stateMachine: makeStateMachine(),
    });

    expect(ctx.get("nope")).toBeUndefined();
  });

  it("state reflects live state machine changes", () => {
    const sm = makeStateMachine();
    const ctx = new ExecutionContext({
      agentId: "agent-1",
      config: makeConfig(),
      stateMachine: sm,
    });

    expect(ctx.state).toBe("idle");
    sm.transition("running");
    expect(ctx.state).toBe("running");
    sm.transition("paused");
    expect(ctx.state).toBe("paused");
    sm.transition("running");
    expect(ctx.state).toBe("running");
    sm.transition("completed");
    expect(ctx.state).toBe("completed");
  });

  it("createChild inherits parent config and state machine", () => {
    const sm = makeStateMachine();
    sm.transition("running");
    const config = makeConfig("parent");
    const parent = new ExecutionContext({
      agentId: "parent",
      config,
      stateMachine: sm,
    });

    const child = parent.createChild("child");

    expect(child.agentId).toBe("child");
    expect(child.config).toBe(parent.config);
    expect(child.state).toBe("running");
    expect(child.parent).toBe(parent);
  });

  it("createChild inherits parent metadata as a copy (not shared)", () => {
    const parent = new ExecutionContext({
      agentId: "parent",
      config: makeConfig(),
      stateMachine: makeStateMachine(),
      metadata: { shared: "value", count: 1 },
    });

    const child = parent.createChild("child");

    expect(child.metadata).toEqual({ shared: "value", count: 1 });
    expect(child.metadata).not.toBe(parent.metadata);
  });

  it("child metadata mutation does not affect parent", () => {
    const parent = new ExecutionContext({
      agentId: "parent",
      config: makeConfig(),
      stateMachine: makeStateMachine(),
      metadata: { key: "original" },
    });

    const child = parent.createChild("child");
    child.set("key", "mutated");
    child.set("newKey", "added");

    expect(parent.get("key")).toBe("original");
    expect(parent.has("newKey")).toBe(false);
    expect(child.get("key")).toBe("mutated");
    expect(child.get("newKey")).toBe("added");
  });

  it("createChild with partial config override replaces specified fields", () => {
    const sm = makeStateMachine();
    const parent = new ExecutionContext({
      agentId: "parent",
      config: createAgentConfig({
        name: "parent",
        maxSteps: 10,
        stepTimeoutMs: 30000,
      }),
      stateMachine: sm,
    });

    const child = parent.createChild("child", {
      maxSteps: 5,
      stepTimeoutMs: 60000,
    });

    expect(child.agentId).toBe("child");
    expect(child.config.maxSteps).toBe(5);
    expect(child.config.stepTimeoutMs).toBe(60000);
    expect(child.state).toBe("idle");
  });

  it("child shares live state with parent via state machine", () => {
    const sm = makeStateMachine();
    const parent = new ExecutionContext({
      agentId: "parent",
      config: makeConfig(),
      stateMachine: sm,
    });
    const child = parent.createChild("child");

    expect(child.state).toBe("idle");
    sm.transition("running");
    expect(child.state).toBe("running");
    expect(parent.state).toBe("running");
  });

  it("toJSON includes current state and parentAgentId", () => {
    const sm = makeStateMachine();
    sm.transition("running");
    const parent = new ExecutionContext({
      agentId: "parent",
      config: makeConfig(),
      stateMachine: sm,
    });
    const child = parent.createChild("child", { maxSteps: 5 });

    const json = JSON.parse(child.toJSON());
    expect(json.agentId).toBe("child");
    expect(json.state).toBe("running");
    expect(json.parentAgentId).toBe("parent");
    expect(json.config.maxSteps).toBe(5);
  });
});
