export type StepType = "perceive" | "reason" | "act" | "observe";

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
