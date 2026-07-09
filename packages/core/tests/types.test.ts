import { describe, it, expect } from "vitest";
import type {
  AgentInput,
  AgentOutput,
  AgentState,
  Event,
  EventType,
  Message,
  Step,
  StepRecord,
  StepStatus,
  StepType,
} from "../src/types/index.js";

const ALL_ROLES = ["system", "user", "assistant", "tool"] as const;
const ALL_STEP_TYPES = ["perceive", "reason", "act", "observe"] as const;
const ALL_AGENT_STATES = ["idle", "running", "paused", "completed", "failed"] as const;
const ALL_EVENT_TYPES = [
  "step_started",
  "step_completed",
  "step_failed",
  "state_changed",
  "agent_started",
  "agent_completed",
  "agent_failed",
] as const;
const ALL_STEP_STATUSES = ["pending", "running", "completed", "failed"] as const;

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
  it("covers all five lifecycle states", () => {
    expect(ALL_AGENT_STATES.length).toBe(5);
    const states: AgentState[] = [...ALL_AGENT_STATES];
    expect(states).toContain("idle");
    expect(states).toContain("running");
    expect(states).toContain("paused");
    expect(states).toContain("completed");
    expect(states).toContain("failed");
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

describe("Event", () => {
  it("accepts all seven event types", () => {
    const events: Event[] = ALL_EVENT_TYPES.map((type, i) => ({
      id: `e-${i}`,
      type,
      payload: { i },
      timestamp: 1700000000000 + i,
    }));
    expect(events.map((e) => e.type)).toEqual([...ALL_EVENT_TYPES]);
  });

  it("discriminates via the type field", () => {
    const e: Event = {
      id: "e1",
      type: "state_changed",
      payload: { from: "idle", to: "running" },
      timestamp: 1,
    };
    const tag: EventType = e.type;
    expect(tag).toBe("state_changed");
  });

  it("accepts arbitrary payload", () => {
    const e: Event = {
      id: "e2",
      type: "step_failed",
      payload: { reason: "timeout", retryable: true, detail: { ms: 30000 } },
      timestamp: 0,
    };
    expect(e.payload.retryable).toBe(true);
  });
});

describe("Step", () => {
  it("accepts all four step types and four statuses", () => {
    const steps: Step[] = ALL_STEP_TYPES.flatMap((type) =>
      ALL_STEP_STATUSES.map((status) => ({
        id: `${type}-${status}`,
        type,
        input: null,
        output: null,
        status,
        timestamp: 0,
      })),
    );
    expect(steps).toHaveLength(ALL_STEP_TYPES.length * ALL_STEP_STATUSES.length);
    expect(steps[0]?.status).toBe<StepStatus>("pending");
  });

  it("discriminates via type and status fields", () => {
    const s: Step = {
      id: "s1",
      type: "reason",
      input: "q",
      output: "a",
      status: "running",
      timestamp: 1,
    };
    expect(s.type).toBe("reason");
    expect(s.status).toBe("running");
  });
});

describe("Barrel re-exports", () => {
  it("exports Message, StepRecord, AgentState, AgentInput, AgentOutput, Event, StepStatus, Step, EventType, StepType", () => {
    const typeNames = [
      "Message",
      "StepRecord",
      "AgentState",
      "AgentInput",
      "AgentOutput",
      "Event",
      "Step",
      "StepStatus",
      "EventType",
      "StepType",
    ];
    expect(typeNames).toHaveLength(10);
  });
});
