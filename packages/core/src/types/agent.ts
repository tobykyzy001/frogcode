import type { StepRecord } from "./step-record.js";

export type AgentState =
  | "idle"
  | "running"
  | "waiting"
  | "finished"
  | "failed"
  | "aborted";

export interface AgentInput {
  prompt: string;
  context?: Record<string, unknown>;
}

export interface AgentOutput {
  steps: StepRecord[];
}
