import type { StepRecord } from "../types/step-record.js";
import type { EventStore } from "./types.js";

export class InMemoryEventStore implements EventStore {
  #store = new Map<string, StepRecord[]>();

  async append(record: StepRecord): Promise<void> {
    const records = this.#store.get(record.agentId) ?? [];
    records.push({ ...record });
    this.#store.set(record.agentId, records);
  }

  async getAll(agentId: string): Promise<StepRecord[]> {
    const records = this.#store.get(agentId);
    return records ? records.map((r) => ({ ...r })) : [];
  }

  async *replay(agentId: string): AsyncIterable<StepRecord> {
    const records = this.#store.get(agentId) ?? [];
    for (const record of records) {
      yield { ...record };
    }
  }

  async clear(agentId: string): Promise<void> {
    this.#store.delete(agentId);
  }
}
