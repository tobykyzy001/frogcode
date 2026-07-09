import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepRecord } from "../src/types/step-record.js";
import { InMemoryEventStore } from "../src/event-store/in-memory.js";
import { FileEventStore } from "../src/event-store/file.js";

function makeRecord(overrides: Partial<StepRecord> = {}): StepRecord {
  return {
    id: "step-1",
    agentId: "agent-a",
    type: "perceive",
    input: null,
    output: null,
    timestamp: Date.now(),
    duration: 100,
    metadata: {},
    ...overrides,
  };
}

describe("InMemoryEventStore", () => {
  const store = new InMemoryEventStore();

  it("should append and retrieve a record", async () => {
    const record = makeRecord();
    await store.append(record);
    const all = await store.getAll("agent-a");
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(record);
  });

  it("should return empty array for non-existent agentId", async () => {
    const all = await store.getAll("nonexistent");
    expect(all).toEqual([]);
  });

  it("should replay records in order via async iteration", async () => {
    const store2 = new InMemoryEventStore();
    const r1 = makeRecord({ id: "s1", timestamp: 1000 });
    const r2 = makeRecord({ id: "s2", timestamp: 2000 });
    const r3 = makeRecord({ id: "s3", timestamp: 3000 });
    await store2.append(r1);
    await store2.append(r2);
    await store2.append(r3);

    const collected: StepRecord[] = [];
    for await (const record of store2.replay("agent-a")) {
      collected.push(record);
    }
    expect(collected).toEqual([r1, r2, r3]);
  });

  it("should clear all records for an agentId", async () => {
    const store3 = new InMemoryEventStore();
    await store3.append(makeRecord({ agentId: "agent-x" }));
    await store3.append(makeRecord({ agentId: "agent-x", id: "s2" }));
    await store3.clear("agent-x");
    const all = await store3.getAll("agent-x");
    expect(all).toEqual([]);
  });

  it("should store multiple records for the same agentId", async () => {
    const store4 = new InMemoryEventStore();
    const r1 = makeRecord({ id: "s1" });
    const r2 = makeRecord({ id: "s2" });
    await store4.append(r1);
    await store4.append(r2);
    const all = await store4.getAll("agent-a");
    expect(all).toHaveLength(2);
    expect(all[0]).toEqual(r1);
    expect(all[1]).toEqual(r2);
  });

  it("should isolate records by agentId", async () => {
    const store5 = new InMemoryEventStore();
    await store5.append(makeRecord({ agentId: "a1", id: "s1" }));
    await store5.append(makeRecord({ agentId: "a2", id: "s2" }));
    const a1 = await store5.getAll("a1");
    const a2 = await store5.getAll("a2");
    expect(a1).toHaveLength(1);
    expect(a2).toHaveLength(1);
    expect(a1[0].agentId).toBe("a1");
    expect(a2[0].agentId).toBe("a2");
  });
});

describe("FileEventStore", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = "" as string;
    }
  });

  it("should append and retrieve a record", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "frogcode-test-"));
    const store = new FileEventStore(tempDir);
    const record = makeRecord();
    await store.append(record);
    const all = await store.getAll("agent-a");
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(record);
  });

  it("should return empty array for non-existent agentId", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "frogcode-test-"));
    const store = new FileEventStore(tempDir);
    const all = await store.getAll("nonexistent");
    expect(all).toEqual([]);
  });

  it("should replay records in order via async iteration", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "frogcode-test-"));
    const store = new FileEventStore(tempDir);
    const r1 = makeRecord({ id: "s1", timestamp: 1000 });
    const r2 = makeRecord({ id: "s2", timestamp: 2000 });
    const r3 = makeRecord({ id: "s3", timestamp: 3000 });
    await store.append(r1);
    await store.append(r2);
    await store.append(r3);

    const collected: StepRecord[] = [];
    for await (const record of store.replay("agent-a")) {
      collected.push(record);
    }
    expect(collected).toEqual([r1, r2, r3]);
  });

  it("should delete the JSONL file on clear", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "frogcode-test-"));
    const store = new FileEventStore(tempDir);
    await store.append(makeRecord({ agentId: "to-clear" }));
    await store.clear("to-clear");
    const all = await store.getAll("to-clear");
    expect(all).toEqual([]);
  });

  it("should write JSON Lines format (one JSON per line)", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "frogcode-test-"));
    const store = new FileEventStore(tempDir);
    const record = makeRecord({ id: "s1" });
    await store.append(record);
    const content = await readFile(join(tempDir, "agent-a.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(record);
  });

  it("should produce multiple lines for multiple records", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "frogcode-test-"));
    const store = new FileEventStore(tempDir);
    const r1 = makeRecord({ id: "s1" });
    const r2 = makeRecord({ id: "s2" });
    await store.append(r1);
    await store.append(r2);
    const content = await readFile(join(tempDir, "agent-a.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(r1);
    expect(JSON.parse(lines[1])).toEqual(r2);
  });

  it("should isolate records by agentId into separate files", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "frogcode-test-"));
    const store = new FileEventStore(tempDir);
    await store.append(makeRecord({ agentId: "alpha", id: "s1" }));
    await store.append(makeRecord({ agentId: "beta", id: "s2" }));
    const alpha = await store.getAll("alpha");
    const beta = await store.getAll("beta");
    expect(alpha).toHaveLength(1);
    expect(beta).toHaveLength(1);
    expect(alpha[0].agentId).toBe("alpha");
    expect(beta[0].agentId).toBe("beta");
  });

  it("clear on non-existent agentId should not throw", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "frogcode-test-"));
    const store = new FileEventStore(tempDir);
    await expect(store.clear("no-such-agent")).resolves.toBeUndefined();
  });
});
