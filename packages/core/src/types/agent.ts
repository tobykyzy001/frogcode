import type { StepRecord } from "./step-record.js";

export type AgentState = "idle" | "running" | "paused" | "completed" | "failed";

export interface AgentInput {
  prompt: string;
  context?: Record<string, unknown>;
}

export interface AgentOutput {
  content: string;
  steps: StepRecord[];
  metadata: Record<string, unknown>;
}
