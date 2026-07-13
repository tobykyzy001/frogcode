import type { StepRecord } from "./step-record.js";

export type AgentState =
  | "idle"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "aborted";

export interface AgentInput {
  prompt: string;
  context?: Record<string, unknown>;
}

export interface AgentOutput {
  steps: StepRecord[];
}
