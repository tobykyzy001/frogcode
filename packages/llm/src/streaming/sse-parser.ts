import type { SSEEvent } from "./types.js";

/**
 * Parses a Server-Sent Events (SSE) byte stream into {@link SSEEvent}s.
 *
 * The parser is provider-agnostic: it only implements the SSE wire format
 * (https://html.spec.whatwg.org/multipage/server-sent-events.html).
 * Provider-specific mapping (e.g. OpenAI delta shape → ChatChunk) is the
 * adapter's job.
 *
 * Behavior:
 * - Events are separated by a blank line (`\n\n`, also tolerates `\r\n\r\n`
 *   and mixed endings via per-chunk CRLF→LF normalization).
 * - `data:` lines within one event are concatenated with `\n`.
 * - `event:`, `id:`, and `retry:` fields are captured when present.
 * - A single leading space after the field colon is stripped (per spec), but
 *   a missing space is also tolerated (`data:value` works).
 * - Lines starting with `:` are comments (heartbeats) and ignored.
 * - An event with no `data`/`event`/`id`/`retry` content yields nothing.
 * - When an event whose `data` equals exactly `"[DONE]"` is yielded, the
 *   generator returns (end-of-stream marker).
 *
 * The parser does NOT implement reconnection or backpressure. Reconnection
 * is the RetryPolicy's responsibility; backpressure is inherent to async
 * generators (consumption pulls production).
 */
export class SSEParser {
  /**
   * Parse an async byte iterable into SSE events.
   *
   * @param stream An async iterable of `Uint8Array` chunks (e.g. a fetch
   *               `Response.body` reader iterable).
   * @yields {@link SSEEvent}
   */
  async *parse(stream: AsyncIterable<Uint8Array>): AsyncGenerator<SSEEvent> {
    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of stream) {
      const decoded = decoder.decode(chunk, { stream: true });
      buffer += normalizeLineEndings(decoded);

      // Drain every complete event currently in the buffer. A complete event
      // is the text up to the first `\n\n` boundary; the remainder (which may
      // be the start of the next event, possibly split across chunks) is kept.
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary === -1) break;
        const eventText = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = this.#parseEvent(eventText);
        if (event === null) continue;
        yield event;
        if (event.data === "[DONE]") return;
      }
    }

    // Flush any trailing bytes the decoder was holding.
    const tail = decoder.decode();
    if (tail.length > 0) {
      buffer += normalizeLineEndings(tail);
    }

    // Do NOT dispatch a trailing event without a `\n\n` boundary. Providers
    // always terminate events with a blank line; a tail without one is either
    // a half-event (connection drop) or whitespace — neither should be yielded.
  }

  /**
   * Parse the text of a single SSE event (the bytes between two `\n\n`
   * boundaries) into an {@link SSEEvent}, or `null` if the event carries no
   * meaningful content (e.g. a heartbeat comment).
   */
  #parseEvent(text: string): SSEEvent | null {
    if (text === "") return null;

    const lines = text.split("\n");
    const dataLines: string[] = [];
    let event: string | undefined;
    let id: string | undefined;
    let retry: number | undefined;

    for (const line of lines) {
      if (line === "") continue;
      if (line.startsWith(":")) continue; // comment / heartbeat

      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) {
        // A field name with no colon has an empty value per spec; we only
        // track known fields, so skip unknown bare-field lines.
        continue;
      }

      const field = line.slice(0, colonIdx);
      let value = line.slice(colonIdx + 1);
      // Spec: a single leading U+0020 SPACE after the colon is stripped.
      // We also tolerate the no-space form (`data:value`).
      if (value.startsWith(" ")) {
        value = value.slice(1);
      }

      switch (field) {
        case "data":
          dataLines.push(value);
          break;
        case "event":
          event = value;
          break;
        case "id":
          id = value;
          break;
        case "retry": {
          const ms = Number(value);
          if (Number.isFinite(ms) && Number.isInteger(ms) && ms >= 0) {
            retry = ms;
          }
          break;
        }
        default:
          // Unknown field per spec — ignore silently.
          break;
      }
    }

    if (
      dataLines.length === 0 &&
      event === undefined &&
      id === undefined &&
      retry === undefined
    ) {
      return null;
    }

    return {
      data: dataLines.join("\n"),
      event,
      id,
      retry,
    };
  }
}

/**
 * Normalize CRLF (`\r\n`) and lone CR (`\r`) to LF (`\n`) so boundary
 * detection only needs to look for `\n\n`.
 *
 * Per-chunk normalization is safe for SSE: a `\r\n` split across a chunk
 * boundary becomes `\n` (from the trailing `\r`) + `\n` (from the next
 * chunk's leading `\n`), which forms a valid blank line — equivalent to the
 * normalized `\r\n` → `\n`.
 */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
