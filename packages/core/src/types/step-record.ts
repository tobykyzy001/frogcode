export type StepType = "perceive" | "reason" | "act" | "observe";

export interface Step {
  id: string;
  type: StepType;
  input: unknown;
  output: unknown;
  status: "pending" | "running" | "completed" | "failed";
  timestamp: number;
}

export type EventType =
  | "step_started"
  | "step_completed"
  | "step_failed"
  | "state_changed"
  | "agent_started"
  | "agent_completed"
  | "agent_failed";

export interface Event {
  id: string;
  type: EventType;
  payload: Record<string, unknown>;
  timestamp: number;
}

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
