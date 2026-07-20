import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { StepRecord } from "@frogcode/core";
import type { Command } from "commander";

const EVENTS_DIR = ".frogcode/events";
const MAX_VALUE_LENGTH = 200;
const STEP_TYPE_WIDTH = 8;
const BREAKDOWN_TYPE_WIDTH = 9;
const LIST_SESSION_ID_WIDTH = 20;
const SUMMARY_RULE = "────────────────────────────";

export interface SessionInfo {
  sessionId: string;
  filePath: string;
  mtime: Date;
}

/**
 * Format an arbitrary input/output value for display.
 *
 * Strings are emitted with surrounding double quotes; everything else is
 * rendered with `JSON.stringify`. Values longer than {@link MAX_VALUE_LENGTH}
 * characters have their content truncated to that limit with an ellipsis
 * suffix appended (still inside the wrapping quotes for strings).
 */
export function formatValue(value: unknown): string {
  if (typeof value === "string") {
    const body =
      value.length > MAX_VALUE_LENGTH
        ? `${value.slice(0, MAX_VALUE_LENGTH)}...`
        : value;
    return `"${body}"`;
  }
  const json = JSON.stringify(value);
  if (json.length > MAX_VALUE_LENGTH) {
    return `${json.slice(0, MAX_VALUE_LENGTH)}...`;
  }
  return json;
}

/**
 * Format a single StepRecord as a multi-line block.
 *
 * The step type is left-padded to {@link STEP_TYPE_WIDTH} characters so the
 * `input:` and `output:` columns align across the four PRAO phases. Duration
 * is emitted as a plain integer in milliseconds. Metadata is intentionally
 * hidden to keep the replay output focused on I/O.
 */
export function formatStep(record: StepRecord, index: number): string {
  const typeLabel = record.type.padEnd(STEP_TYPE_WIDTH);
  const header = `[${index}] ${typeLabel} ─ ${record.duration}ms`;
  const inputLine = `    input:  ${formatValue(record.input)}`;
  const outputLine = `    output: ${formatValue(record.output)}`;
  return `${header}\n${inputLine}\n${outputLine}`;
}

/**
 * Format the post-replay summary block.
 *
 * Aggregates total step count, total duration, and per-type breakdown with
 * percentage share. An empty `steps` array yields a minimal "no steps"
 * summary so the caller does not need to special-case it.
 */
export function formatSummary(steps: StepRecord[]): string {
  const totalSteps = steps.length;
  const totalTime = steps.reduce((sum, step) => sum + step.duration, 0);

  if (totalSteps === 0) {
    return `${SUMMARY_RULE}\nTotal steps: 0\nTotal time:  0ms`;
  }

  const breakdown = new Map<StepRecord["type"], number>();
  for (const step of steps) {
    breakdown.set(step.type, (breakdown.get(step.type) ?? 0) + step.duration);
  }

  const lines: string[] = [
    SUMMARY_RULE,
    `Total steps: ${totalSteps}`,
    `Total time:  ${totalTime}ms`,
    "Breakdown:",
  ];

  for (const [type, duration] of breakdown) {
    const percentage = (duration / totalTime) * 100;
    const typeLabel = `${type}:`.padEnd(BREAKDOWN_TYPE_WIDTH);
    const durationLabel = `${duration}ms`.padStart(7);
    lines.push(`  ${typeLabel}${durationLabel} (${percentage.toFixed(1)}%)`);
  }

  return lines.join("\n");
}

/**
 * Format a {@link Date} as `YYYY-MM-DD HH:MM:SS` in local time.
 */
function formatMtime(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Enumerate `.jsonl` session files under `eventsDir`, sorted by modification
 * time descending (newest first).
 *
 * Returns an empty array when the directory does not exist or contains no
 * matching files — callers translate that to the "no sessions found" UX.
 */
export async function listSessions(eventsDir: string): Promise<SessionInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(eventsDir);
  } catch {
    return [];
  }

  const jsonlEntries = entries.filter((name) => name.endsWith(".jsonl"));

  const infos: SessionInfo[] = [];
  for (const name of jsonlEntries) {
    const filePath = join(eventsDir, name);
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      continue;
    }
    infos.push({
      sessionId: name.slice(0, -".jsonl".length),
      filePath,
      mtime: fileStat.mtime,
    });
  }

  infos.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return infos;
}

/**
 * Read a JSON Lines session file and parse it into StepRecords.
 *
 * Empty/whitespace-only lines are skipped. Throws if the file does not exist
 * or contains malformed JSON — callers surface the error to the user.
 */
export async function replaySession(filePath: string): Promise<StepRecord[]> {
  const content = await readFile(filePath, "utf-8");
  const records: StepRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    records.push(JSON.parse(trimmed) as StepRecord);
  }
  return records;
}

/**
 * Render the list-mode output for available sessions.
 */
function renderSessionList(sessions: SessionInfo[]): string {
  if (sessions.length === 0) {
    return `No sessions found in ${EVENTS_DIR}/`;
  }

  const lines: string[] = ["Available sessions:", ""];
  for (const session of sessions) {
    const idLabel = session.sessionId.padEnd(LIST_SESSION_ID_WIDTH);
    lines.push(`${idLabel}${formatMtime(session.mtime)}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Render the replay-mode output: one formatted step per record followed by
 * the summary block.
 */
function renderReplay(records: StepRecord[]): string {
  const blocks: string[] = [];
  records.forEach((record, idx) => {
    blocks.push(formatStep(record, idx + 1));
  });
  blocks.push(formatSummary(records));
  return `${blocks.join("\n")}\n`;
}

/**
 * Register the `frogcode trace` subcommand.
 *
 * Without a `session-id` argument, lists available session files under
 * `.frogcode/events/`. With one, replays the corresponding `.jsonl` file as a
 * formatted StepRecord trace plus summary block.
 */
export function registerTraceCommand(program: Command): void {
  program
    .command("trace [session-id]")
    .description("Replay StepRecords from an EventStore session")
    .action(async (sessionId?: string) => {
      try {
        if (sessionId === undefined) {
          const sessions = await listSessions(EVENTS_DIR);
          process.stdout.write(renderSessionList(sessions));
          return;
        }

        const fileName = sessionId.endsWith(".jsonl")
          ? sessionId
          : `${sessionId}.jsonl`;
        const filePath = join(EVENTS_DIR, fileName);

        let records: StepRecord[];
        try {
          records = await replaySession(filePath);
        } catch (error) {
          const isMissing =
            error instanceof Error &&
            "code" in error &&
            (error as NodeJS.ErrnoException).code === "ENOENT";
          if (isMissing) {
            process.stderr.write(`\u274C Session not found: ${sessionId}\n`);
            process.exitCode = 1;
            return;
          }
          throw error;
        }

        process.stdout.write(renderReplay(records));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`\u274C Failed to trace session: ${message}\n`);
        process.exitCode = 1;
      }
    });
}
