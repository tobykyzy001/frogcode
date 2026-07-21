export type StepType =
  | "perceive"
  | "reason"
  | "act"
  | "observe"
  | "tool_call"
  | "tool_result";

export interface StepRecord {
  id: string;
  agentId: string;
  type: StepType;
  input: unknown;
  output: unknown;
  timestamp: number;
  duration: number;
  metadata: Record<string, unknown>;
}
