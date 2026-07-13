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
  it("should append and retrieve a record", async () => {
    const store = new InMemoryEventStore();
    const record = makeRecord();
    await store.append(record);
    const all = await store.getAll("agent-a");
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(record);
  });

  it("should return empty array for non-existent agentId", async () => {
    const store = new InMemoryEventStore();
    const all = await store.getAll("nonexistent");
    expect(all).toEqual([]);
  });

  it("should replay records in order via async iteration", async () => {
    const store = new InMemoryEventStore();
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

  it("should clear all records for an agentId", async () => {
    const store = new InMemoryEventStore();
    await store.append(makeRecord({ agentId: "agent-x" }));
    await store.append(makeRecord({ agentId: "agent-x", id: "s2" }));
    await store.clear("agent-x");
    const all = await store.getAll("agent-x");
    expect(all).toEqual([]);
  });

  it("should store multiple records for the same agentId", async () => {
    const store = new InMemoryEventStore();
    const r1 = makeRecord({ id: "s1" });
    const r2 = makeRecord({ id: "s2" });
    await store.append(r1);
    await store.append(r2);
    const all = await store.getAll("agent-a");
    expect(all).toHaveLength(2);
    expect(all[0]).toEqual(r1);
    expect(all[1]).toEqual(r2);
  });

  it("should isolate records by agentId", async () => {
    const store = new InMemoryEventStore();
    await store.append(makeRecord({ agentId: "a1", id: "s1" }));
    await store.append(makeRecord({ agentId: "a2", id: "s2" }));
    const a1 = await store.getAll("a1");
    const a2 = await store.getAll("a2");
    expect(a1).toHaveLength(1);
    expect(a2).toHaveLength(1);
    expect(a1[0].agentId).toBe("a1");
    expect(a2[0].agentId).toBe("a2");
  });

  it("getAll() returns copies - mutating result does not affect store", async () => {
    const store = new InMemoryEventStore();
    await store.append(makeRecord({ id: "s1", type: "perceive" }));
    const all = await store.getAll("agent-a");
    all[0].type = "reason";
    all[0].metadata = { hacked: true };

    const fresh = await store.getAll("agent-a");
    expect(fresh[0].type).toBe("perceive");
    expect(fresh[0].metadata).toEqual({});
  });

  it("replay() yields copies - mutating yielded records does not affect store", async () => {
    const store = new InMemoryEventStore();
    await store.append(makeRecord({ id: "s1" }));

    for await (const record of store.replay("agent-a")) {
      record.id = "hacked";
      record.metadata = { evil: true };
    }

    const fresh = await store.getAll("agent-a");
    expect(fresh[0].id).toBe("s1");
    expect(fresh[0].metadata).toEqual({});
  });

  it("append() stores a copy - mutating original does not affect store", async () => {
    const store = new InMemoryEventStore();
    const record = makeRecord({ id: "s1" });
    await store.append(record);
    record.id = "mutated";
    record.metadata = { changed: true };

    const fresh = await store.getAll("agent-a");
    expect(fresh[0].id).toBe("s1");
    expect(fresh[0].metadata).toEqual({});
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

  it("should throw ENOENT for non-existent agentId in getAll", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "frogcode-test-"));
    const store = new FileEventStore(tempDir);
    await expect(store.getAll("nonexistent")).rejects.toThrow();
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
    // File is deleted — getAll throws ENOENT
    await expect(store.getAll("to-clear")).rejects.toThrow();
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

  it("clear on non-existent agentId throws ENOENT", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "frogcode-test-"));
    const store = new FileEventStore(tempDir);
    await expect(store.clear("no-such-agent")).rejects.toThrow();
  });

  it("serializes concurrent appends without interleaving lines", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "frogcode-test-"));
    const store = new FileEventStore(tempDir);
    const records = Array.from({ length: 20 }, (_, i) =>
      makeRecord({ id: `s${i}`, timestamp: i }),
    );
    await Promise.all(records.map((r) => store.append(r)));

    const all = await store.getAll("agent-a");
    expect(all).toHaveLength(20);
    const ids = all.map((r) => r.id).sort();
    expect(ids).toEqual(
      Array.from({ length: 20 }, (_, i) => `s${i}`).sort(),
    );
  });
});
