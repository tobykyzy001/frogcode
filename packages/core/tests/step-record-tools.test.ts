import { describe, it, expect } from "vitest";
import type { StepRecord, StepType } from "../src/index.js";

describe("StepRecord with tool_call/tool_result", () => {
  it("StepType includes tool_call", () => {
    const type: StepType = "tool_call";
    expect(type).toBe("tool_call");
  });

  it("StepType includes tool_result", () => {
    const type: StepType = "tool_result";
    expect(type).toBe("tool_result");
  });

  it("StepRecord with type=tool_call can be created", () => {
    const record: StepRecord = {
      id: "step-1",
      agentId: "agent-1",
      type: "tool_call",
      input: { toolName: "fs.read", arguments: { path: "/tmp/x" } },
      output: null,
      timestamp: Date.now(),
      duration: 0,
      metadata: { toolCallId: "call-1" },
    };
    expect(record.type).toBe("tool_call");
    expect(record.metadata.toolCallId).toBe("call-1");
  });

  it("StepRecord with type=tool_result can be created", () => {
    const record: StepRecord = {
      id: "step-2",
      agentId: "agent-1",
      type: "tool_result",
      input: null,
      output: { content: "hello", bytes: 5 },
      timestamp: Date.now(),
      duration: 12,
      metadata: { toolCallId: "call-1", success: true },
    };
    expect(record.type).toBe("tool_result");
    expect(record.metadata.success).toBe(true);
  });

  it("tool_result can carry error in output", () => {
    const record: StepRecord = {
      id: "step-3",
      agentId: "agent-1",
      type: "tool_result",
      input: null,
      output: { error: "ToolTimeoutError", message: "exceeded 60s" },
      timestamp: Date.now(),
      duration: 60000,
      metadata: { toolCallId: "call-2", success: false },
    };
    expect(record.type).toBe("tool_result");
    expect(record.metadata.success).toBe(false);
  });

  it("existing StepType values still work", () => {
    const types: StepType[] = ["perceive", "reason", "act", "observe", "tool_call", "tool_result"];
    expect(types).toHaveLength(6);
  });
});
