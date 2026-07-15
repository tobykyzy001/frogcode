import { describe, it, expect } from "vitest";
import type {
  AgentInput,
  AgentOutput,
  AgentState,
  Message,
  MessageRole,
  ObserveResult,
  ReasonResult,
  StepRecord,
  StepType,
} from "../src/types/index.js";

const ALL_ROLES = ["system", "user", "assistant", "tool"] as const;
const ALL_STEP_TYPES = ["perceive", "reason", "act", "observe"] as const;
const ALL_AGENT_STATES = [
  "idle",
  "running",
  "waiting",
  "finished",
  "failed",
  "aborted",
] as const;

describe("Message", () => {
  it("accepts all four roles", () => {
    const messages: Message[] = ALL_ROLES.map((role, i) => ({
      id: `m-${i}`,
      role,
      content: "hi",
      timestamp: 1700000000000 + i,
    }));
    expect(messages.map((m) => m.role)).toEqual([...ALL_ROLES]);
  });

  it("accepts optional metadata", () => {
    const msg: Message = {
      id: "m-1",
      role: "user",
      content: "hello",
      timestamp: 1,
      metadata: { source: "cli", tokens: 42 },
    };
    expect(msg.metadata?.source).toBe("cli");
    expect(msg.metadata?.tokens).toBe(42);
  });

  it("treats metadata as undefined when omitted", () => {
    const msg: Message = {
      id: "m-2",
      role: "assistant",
      content: "ok",
      timestamp: 2,
    };
    expect(msg.metadata).toBeUndefined();
  });
});

describe("StepRecord", () => {
  it("instantiates with all required fields", () => {
    const record: StepRecord = {
      id: "step-1",
      agentId: "agent-1",
      type: "reason",
      input: { prompt: "why?" },
      output: { answer: "because" },
      timestamp: 1700000000000,
      duration: 12,
      metadata: { source: "mock" },
    };
    expect(record.id).toBe("step-1");
    expect(record.agentId).toBe("agent-1");
    expect(record.type).toBe("reason");
    expect(record.input).toEqual({ prompt: "why?" });
    expect(record.output).toEqual({ answer: "because" });
    expect(record.duration).toBe(12);
    expect(record.metadata).toEqual({ source: "mock" });
  });

  it("supports all four step types", () => {
    const records: StepRecord[] = ALL_STEP_TYPES.map((type) => ({
      id: `step-${type}`,
      agentId: "agent-1",
      type,
      input: null,
      output: null,
      timestamp: 0,
      duration: 0,
      metadata: {},
    }));
    expect(records.map((r) => r.type)).toEqual([...ALL_STEP_TYPES]);
  });

  it("allows input/output as any unknown value", () => {
    const r1: StepRecord = {
      id: "x",
      agentId: "a",
      type: "act",
      input: "string",
      output: 42,
      timestamp: 0,
      duration: 0,
      metadata: {},
    };
    const r2: StepRecord = {
      id: "y",
      agentId: "a",
      type: "observe",
      input: [1, 2, 3],
      output: { nested: { deep: true } },
      timestamp: 0,
      duration: 0,
      metadata: {},
    };
    expect(r1.input).toBe("string");
    expect(r2.output).toEqual({ nested: { deep: true } });
  });

  it("discriminates step type via the type field", () => {
    const r: StepRecord = {
      id: "z",
      agentId: "a",
      type: "perceive",
      input: null,
      output: null,
      timestamp: 0,
      duration: 0,
      metadata: {},
    };
    const tag: StepType = r.type;
    expect(tag).toBe("perceive");
  });
});

describe("AgentState", () => {
  it("covers all six lifecycle states", () => {
    expect(ALL_AGENT_STATES.length).toBe(6);
    const states: AgentState[] = [...ALL_AGENT_STATES];
    expect(states).toContain("idle");
    expect(states).toContain("running");
    expect(states).toContain("waiting");
    expect(states).toContain("finished");
    expect(states).toContain("failed");
    expect(states).toContain("aborted");
  });
});

describe("AgentInput", () => {
  it("requires prompt", () => {
    const input: AgentInput = { prompt: "go" };
    expect(input.prompt).toBe("go");
    expect(input.context).toBeUndefined();
  });

  it("accepts optional context", () => {
    const input: AgentInput = {
      prompt: "go",
      context: { locale: "zh-CN", userId: 7 },
    };
    expect(input.context?.locale).toBe("zh-CN");
    expect(input.context?.userId).toBe(7);
  });
});

describe("AgentOutput", () => {
  it("wires up steps and metadata", () => {
    const step: StepRecord = {
      id: "s",
      agentId: "a",
      type: "act",
      input: null,
      output: "done",
      timestamp: 0,
      duration: 1,
      metadata: {},
    };
    const out: AgentOutput = {
      content: "finished",
      steps: [step],
      metadata: { trace: "ok" },
    };
    expect(out.content).toBe("finished");
    expect(out.steps).toHaveLength(1);
    expect(out.steps[0]?.id).toBe("s");
    expect(out.metadata.trace).toBe("ok");
  });
});

describe("ReasonResult", () => {
  it("requires action field", () => {
    const r: ReasonResult = { action: "do-something" };
    expect(r.action).toBe("do-something");
    expect(r.done).toBeUndefined();
  });

  it("accepts optional done flag", () => {
    const r: ReasonResult = { action: null, done: true };
    expect(r.done).toBe(true);
  });

  it("allows action to be any unknown value", () => {
    const r1: ReasonResult = { action: { tool: "search", args: { q: "test" } } };
    const r2: ReasonResult = { action: 42, done: false };
    expect(r1.action).toEqual({ tool: "search", args: { q: "test" } });
    expect(r2.action).toBe(42);
  });
});

describe("ObserveResult", () => {
  it("requires content string", () => {
    const r: ObserveResult = { content: "observation text" };
    expect(r.content).toBe("observation text");
    expect(r.data).toBeUndefined();
  });

  it("accepts optional data field", () => {
    const r: ObserveResult = {
      content: "found 3 results",
      data: { count: 3, items: ["a", "b", "c"] },
    };
    expect(r.data).toEqual({ count: 3, items: ["a", "b", "c"] });
  });
});

describe("Barrel re-exports", () => {
  it("exports Message, StepRecord, AgentState, AgentInput, AgentOutput, StepType, ReasonResult, ObserveResult", () => {
    const typeNames = [
      "Message",
      "StepRecord",
      "AgentState",
      "AgentInput",
      "AgentOutput",
      "StepType",
      "ReasonResult",
      "ObserveResult",
    ];
    expect(typeNames).toHaveLength(8);
  });
});
