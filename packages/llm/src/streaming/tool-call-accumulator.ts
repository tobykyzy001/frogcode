import type { ToolCall } from "../types/index.js";

/**
 * Internal mutable state for a single tool call being accumulated.
 *
 * `argumentsBuffer` holds raw JSON string fragments concatenated in arrival
 * order (OpenAI-style streaming). `argumentsObject` holds a complete object
 * if a provider sent the arguments as an object instead of string deltas.
 * At `complete()` time, the buffer (if non-empty) is JSON.parsed and takes
 * precedence over the object form.
 */
interface AccumulatorEntry {
  id?: string;
  name?: string;
  argumentsBuffer: string;
  argumentsObject?: Record<string, unknown>;
}

/**
 * Accumulates streaming tool-call fragments into complete {@link ToolCall}s.
 *
 * LLM streaming protocols (OpenAI, Anthropic) deliver a single tool call
 * across many chunks: the first chunk usually carries `id` + `name`, and
 * subsequent chunks carry `arguments` as JSON string deltas that must be
 * concatenated and parsed once the stream ends.
 *
 * Usage:
 * ```ts
 * const acc = new ToolCallAccumulator();
 * acc.add(0, { id: "call_1", name: "search" });
 * acc.addArgumentsDelta(0, '{"query":"');
 * acc.addArgumentsDelta(0, 'frog"}');
 * acc.complete();
 * const calls = acc.getAll(); // [{ id, name, arguments: { query: "frog" } }]
 * ```
 *
 * Contract:
 * - `add` / `addArgumentsDelta` may only be called before `complete()`.
 * - `get` / `getAll` may only be called after `complete()`.
 * - Every accumulated index MUST have `id` and `name` set by `complete()`;
 *   otherwise `complete()` throws (no silent fallback — see AGENTS.md).
 */
export class ToolCallAccumulator {
  #entries = new Map<number, AccumulatorEntry>();
  #completed = false;
  #completedCalls = new Map<number, ToolCall>();

  /**
   * Merge a fragment for the tool call at `index`.
   *
   * - If `fragment.id` is set, it becomes (or overwrites) the tool call's id.
   * - If `fragment.name` is set, it becomes (or overwrites) the tool call's name.
   * - If `fragment.arguments` is set as an object, it is stored as the
   *   complete arguments object (used only if no string deltas were added).
   *
   * String argument deltas must be fed via {@link addArgumentsDelta}.
   */
  add(index: number, fragment: Partial<ToolCall>): void {
    this.#ensureMutable();
    const entry = this.#touch(index);
    if (fragment.id !== undefined) {
      entry.id = fragment.id;
    }
    if (fragment.name !== undefined) {
      entry.name = fragment.name;
    }
    if (fragment.arguments !== undefined) {
      entry.argumentsObject = fragment.arguments;
    }
  }

  /**
   * Append a JSON string fragment to the arguments buffer for `index`.
   *
   * Fragments arrive in order and are concatenated verbatim. The accumulated
   * string is JSON.parsed exactly once, at {@link complete} time.
   */
  addArgumentsDelta(index: number, delta: string): void {
    this.#ensureMutable();
    const entry = this.#touch(index);
    entry.argumentsBuffer += delta;
  }

  /**
   * Finalize all accumulated tool calls.
   *
   * For each index: JSON.parses the arguments buffer (if any), validates that
   * `id` and `name` are present, and freezes the result for {@link get} /
   * {@link getAll}. Idempotent — calling twice is a no-op.
   *
   * @throws {Error} if any entry is missing `id` or `name`.
   * @throws {SyntaxError} if an arguments buffer is not valid JSON.
   */
  complete(): void {
    if (this.#completed) return;

    const calls = new Map<number, ToolCall>();
    for (const [index, entry] of this.#entries) {
      const { id, name } = entry;
      if (id === undefined) {
        throw new Error(
          `ToolCallAccumulator: tool call at index ${index} is missing id`,
        );
      }
      if (name === undefined) {
        throw new Error(
          `ToolCallAccumulator: tool call at index ${index} is missing name`,
        );
      }

      const arguments_ = this.#resolveArguments(entry);

      calls.set(index, { id, name, arguments: arguments_ });
    }

    this.#completedCalls = calls;
    this.#completed = true;
  }

  /**
   * Return the completed {@link ToolCall} at `index`, or `undefined` if no
   * fragments were ever added for that index.
   *
   * @throws {Error} if `complete()` has not been called.
   */
  get(index: number): ToolCall | undefined {
    this.#ensureCompleted();
    return this.#completedCalls.get(index);
  }

  /**
   * Return all completed tool calls, ordered ascending by index.
   *
   * Returns a fresh array on each call so callers cannot mutate internal state.
   *
   * @throws {Error} if `complete()` has not been called.
   */
  getAll(): ToolCall[] {
    this.#ensureCompleted();
    return Array.from(this.#completedCalls.keys())
      .sort((a, b) => a - b)
      .map((i) => this.#completedCalls.get(i) as ToolCall);
  }

  /**
   * Get or create the mutable entry for `index`.
   */
  #touch(index: number): AccumulatorEntry {
    let entry = this.#entries.get(index);
    if (entry === undefined) {
      entry = { argumentsBuffer: "" };
      this.#entries.set(index, entry);
    }
    return entry;
  }

  /**
   * Resolve the final arguments object for an entry.
   *
   * Precedence: string deltas (JSON.parsed) > complete object > empty object.
   * An empty object is the correct representation of "no arguments", not a
   * fallback.
   */
  #resolveArguments(entry: AccumulatorEntry): Record<string, unknown> {
    if (entry.argumentsBuffer.length > 0) {
      return JSON.parse(entry.argumentsBuffer) as Record<string, unknown>;
    }
    if (entry.argumentsObject !== undefined) {
      return entry.argumentsObject;
    }
    return {};
  }

  #ensureMutable(): void {
    if (this.#completed) {
      throw new Error(
        "ToolCallAccumulator: cannot add fragments after complete() has been called",
      );
    }
  }

  #ensureCompleted(): void {
    if (!this.#completed) {
      throw new Error(
        "ToolCallAccumulator: complete() must be called before reading results",
      );
    }
  }
}
