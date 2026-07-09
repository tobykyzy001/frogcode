import type { StepRecord } from "../types/step-record.js";

export interface EventStore {
  append(record: StepRecord): Promise<void>;
  getAll(agentId: string): Promise<StepRecord[]>;
  replay(agentId: string): AsyncIterable<StepRecord>;
  clear(agentId: string): Promise<void>;
}
