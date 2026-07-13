import { createReadStream } from "node:fs";
import { appendFile, mkdir, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { StepRecord } from "../types/step-record.js";
import type { EventStore } from "./types.js";

export class FileEventStore implements EventStore {
  #writeQueues = new Map<string, Promise<void>>();

  constructor(private readonly basePath: string) {}

  async append(record: StepRecord): Promise<void> {
    const agentId = record.agentId;
    const filePath = this.#filePath(agentId);
    const prev = this.#writeQueues.get(agentId) ?? Promise.resolve();
    const next = prev.then(() => this.#writeLine(filePath, record));
    this.#writeQueues.set(agentId, next);
    await next;
  }

  async getAll(agentId: string): Promise<StepRecord[]> {
    const filePath = this.#filePath(agentId);
    const content = await readFile(filePath, "utf-8");
    return content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StepRecord);
  }

  async *replay(agentId: string): AsyncIterable<StepRecord> {
    const filePath = this.#filePath(agentId);
    const stream = createReadStream(filePath, "utf-8");

    const opened = new Promise<void>((resolve, reject) => {
      stream.once("open", () => resolve());
      stream.once("error", reject);
    });
    await opened;
    stream.removeAllListeners("open");
    stream.removeAllListeners("error");

    const rl = createInterface({
      input: stream,
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed) {
        yield JSON.parse(trimmed) as StepRecord;
      }
    }
  }

  async clear(agentId: string): Promise<void> {
    const filePath = this.#filePath(agentId);
    await unlink(filePath);
  }

  async #writeLine(filePath: string, record: StepRecord): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const line = `${JSON.stringify(record)}\n`;
    await appendFile(filePath, line, "utf-8");
  }

  #filePath(agentId: string): string {
    return join(this.basePath, `${agentId}.jsonl`);
  }
}
