import { appendFile, mkdir, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StepRecord } from "../types/step-record.js";
import type { EventStore } from "./types.js";

export class FileEventStore implements EventStore {
  constructor(private readonly basePath: string) {}

  async append(record: StepRecord): Promise<void> {
    const filePath = this.#filePath(record.agentId);
    await mkdir(dirname(filePath), { recursive: true });
    const line = `${JSON.stringify(record)}\n`;
    await appendFile(filePath, line, "utf-8");
  }

  async getAll(agentId: string): Promise<StepRecord[]> {
    const filePath = this.#filePath(agentId);
    try {
      const content = await readFile(filePath, "utf-8");
      return content
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as StepRecord);
    } catch {
      return [];
    }
  }

  async *replay(agentId: string): AsyncIterable<StepRecord> {
    const records = await this.getAll(agentId);
    for (const record of records) {
      yield record;
    }
  }

  async clear(agentId: string): Promise<void> {
    const filePath = this.#filePath(agentId);
    try {
      await unlink(filePath);
    } catch {
      // file may not exist, that's fine
    }
  }

  #filePath(agentId: string): string {
    return join(this.basePath, `${agentId}.jsonl`);
  }
}
