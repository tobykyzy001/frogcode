import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepRecord } from "@frogcode/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatStep,
  formatSummary,
  listSessions,
  replaySession,
} from "../src/commands/trace.js";

function makeStep(
  overrides: Partial<StepRecord> & Pick<StepRecord, "type">,
): StepRecord {
  return {
    id: overrides.id ?? `step-${Math.random().toString(36).slice(2)}`,
    agentId: overrides.agentId ?? "cli-chat",
    type: overrides.type,
    input: overrides.input ?? null,
    output: overrides.output ?? null,
    timestamp: overrides.timestamp ?? 0,
    duration: overrides.duration ?? 0,
    metadata: overrides.metadata ?? {},
  };
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "frogcode-trace-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("formatStep", () => {
  it("formats a perceive step with index, padded type, and duration", () => {
    const step = makeStep({ type: "perceive", duration: 234 });
    const formatted = formatStep(step, 1);
    expect(formatted).toBe(
      "[1] perceive ─ 234ms\n" + "    input:  null\n" + "    output: null",
    );
  });

  it("left-pads shorter step types so columns align with 'perceive'", () => {
    const reason = makeStep({ type: "reason", duration: 567 });
    const act = makeStep({ type: "act", duration: 1 });
    const observe = makeStep({ type: "observe", duration: 12 });

    const reasonHeader = formatStep(reason, 2).split("\n")[0];
    const actHeader = formatStep(act, 3).split("\n")[0];
    const observeHeader = formatStep(observe, 4).split("\n")[0];

    expect(reasonHeader).toBe("[2] reason   ─ 567ms");
    expect(actHeader).toBe("[3] act      ─ 1ms");
    expect(observeHeader).toBe("[4] observe  ─ 12ms");
  });

  it("wraps string input and output in double quotes", () => {
    const step = makeStep({
      type: "perceive",
      input: "你好",
      output: "你好！",
    });
    const formatted = formatStep(step, 1);
    expect(formatted).toContain('input:  "你好"');
    expect(formatted).toContain('output: "你好！"');
  });

  it("renders object input and output via JSON.stringify", () => {
    const step = makeStep({
      type: "reason",
      input: "你好！",
      output: { action: "respond", done: true },
    });
    const formatted = formatStep(step, 2);
    expect(formatted).toContain('input:  "你好！"');
    expect(formatted).toContain('output: {"action":"respond","done":true}');
  });

  it("truncates values longer than 200 characters with an ellipsis suffix", () => {
    const longString = "a".repeat(250);
    const step = makeStep({
      type: "perceive",
      input: longString,
      output: "ok",
    });
    const formatted = formatStep(step, 1);

    const inputLine = formatted.split("\n")[1];
    expect(inputLine).toBeDefined();
    // Truncate body to 200 'a' chars + "..." inside wrapping quotes
    expect(inputLine).toBe(`    input:  "${"a".repeat(200)}..."`);
  });

  it("does not truncate values at exactly 200 characters", () => {
    const exactString = "b".repeat(200);
    const step = makeStep({
      type: "perceive",
      input: exactString,
      output: "ok",
    });
    const formatted = formatStep(step, 1);
    const inputLine = formatted.split("\n")[1];
    expect(inputLine).toBe(`    input:  "${exactString}"`);
  });

  it("omits metadata from the output entirely", () => {
    const step = makeStep({
      type: "perceive",
      input: "x",
      output: "y",
      metadata: { secret: "should-not-appear", nested: { foo: "bar" } },
    });
    const formatted = formatStep(step, 1);
    expect(formatted).not.toContain("metadata");
    expect(formatted).not.toContain("secret");
    expect(formatted).not.toContain("should-not-appear");
  });
});

describe("formatSummary", () => {
  it("reports zero totals for an empty step list", () => {
    const summary = formatSummary([]);
    expect(summary).toContain("Total steps: 0");
    expect(summary).toContain("Total time:  0ms");
    expect(summary).not.toContain("Breakdown:");
  });

  it("sums total step count and total duration", () => {
    const steps: StepRecord[] = [
      makeStep({ type: "perceive", duration: 234 }),
      makeStep({ type: "reason", duration: 567 }),
      makeStep({ type: "act", duration: 1 }),
      makeStep({ type: "observe", duration: 12 }),
    ];
    const summary = formatSummary(steps);
    expect(summary).toContain("Total steps: 4");
    expect(summary).toContain("Total time:  814ms");
  });

  it("computes per-type breakdown with percentage shares", () => {
    const steps: StepRecord[] = [
      makeStep({ type: "perceive", duration: 234 }),
      makeStep({ type: "reason", duration: 567 }),
      makeStep({ type: "act", duration: 1 }),
      makeStep({ type: "observe", duration: 12 }),
    ];
    const summary = formatSummary(steps);
    expect(summary).toContain("Breakdown:");
    expect(summary).toMatch(/perceive:\s*234ms \(28\.7%\)/);
    expect(summary).toMatch(/reason:\s*567ms \(69\.7%\)/);
    expect(summary).toMatch(/act:\s*1ms\s+\(0\.1%\)/);
    expect(summary).toMatch(/observe:\s*12ms\s+\(1\.5%\)/);
  });

  it("aggregates durations when multiple steps share a type", () => {
    const steps: StepRecord[] = [
      makeStep({ type: "perceive", duration: 100 }),
      makeStep({ type: "perceive", duration: 200 }),
      makeStep({ type: "act", duration: 100 }),
    ];
    const summary = formatSummary(steps);
    expect(summary).toContain("Total steps: 3");
    expect(summary).toContain("Total time:  400ms");
    expect(summary).toMatch(/perceive:\s*300ms \(75\.0%\)/);
    expect(summary).toMatch(/act:\s*100ms\s+\(25\.0%\)/);
  });

  it("renders the horizontal rule above the totals", () => {
    const summary = formatSummary([
      makeStep({ type: "perceive", duration: 1 }),
    ]);
    const firstLine = summary.split("\n")[0];
    expect(firstLine).toBe("────────────────────────────");
  });
});

describe("listSessions", () => {
  it("returns an empty array when the directory does not exist", async () => {
    const missing = join(workDir, "does-not-exist");
    const sessions = await listSessions(missing);
    expect(sessions).toEqual([]);
  });

  it("returns an empty array when the directory has no .jsonl files", async () => {
    const sessions = await listSessions(workDir);
    expect(sessions).toEqual([]);
  });

  it("lists .jsonl files with session IDs and file paths", async () => {
    await writeFile(join(workDir, "alpha.jsonl"), "{}\n");
    await writeFile(join(workDir, "beta.jsonl"), "{}\n");
    await writeFile(join(workDir, "ignore.txt"), "not a session\n");

    const sessions = await listSessions(workDir);
    expect(sessions).toHaveLength(2);
    const ids = sessions.map((s) => s.sessionId).sort();
    expect(ids).toEqual(["alpha", "beta"]);
    for (const session of sessions) {
      expect(session.filePath.endsWith(".jsonl")).toBe(true);
      expect(session.mtime).toBeInstanceOf(Date);
    }
  });

  it("sorts sessions by modification time descending (newest first)", async () => {
    const older = join(workDir, "older.jsonl");
    const newer = join(workDir, "newer.jsonl");
    await writeFile(older, "old\n");
    // Ensure a strictly newer mtime even on filesystems with second-resolution stamps
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(newer, "new\n");

    const sessions = await listSessions(workDir);
    expect(sessions.map((s) => s.sessionId)).toEqual(["newer", "older"]);
  });
});

describe("replaySession", () => {
  it("parses JSON Lines into a StepRecord array", async () => {
    const path = join(workDir, "session.jsonl");
    const records: StepRecord[] = [
      makeStep({
        id: "s1",
        type: "perceive",
        duration: 10,
        input: "hi",
        output: "hi",
      }),
      makeStep({
        id: "s2",
        type: "reason",
        duration: 20,
        input: "hi",
        output: { action: "ok" },
      }),
    ];
    const content = `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
    await writeFile(path, content);

    const parsed = await replaySession(path);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.id).toBe("s1");
    expect(parsed[1]?.output).toEqual({ action: "ok" });
  });

  it("skips empty and whitespace-only lines", async () => {
    const path = join(workDir, "session.jsonl");
    const record = makeStep({ id: "only", type: "act", duration: 5 });
    const content = `\n${JSON.stringify(record)}\n   \n\n`;
    await writeFile(path, content);

    const parsed = await replaySession(path);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe("only");
  });

  it("returns an empty array for an empty file", async () => {
    const path = join(workDir, "empty.jsonl");
    await writeFile(path, "");
    const parsed = await replaySession(path);
    expect(parsed).toEqual([]);
  });

  it("throws when the file does not exist", async () => {
    const path = join(workDir, "missing.jsonl");
    await expect(replaySession(path)).rejects.toThrow();
  });

  it("throws when a line contains malformed JSON", async () => {
    const path = join(workDir, "broken.jsonl");
    await writeFile(path, "{ not valid json\n");
    await expect(replaySession(path)).rejects.toThrow();
  });
});
