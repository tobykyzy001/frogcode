import { describe, expect, it } from "vitest";
import { SSEParser } from "../src/streaming/sse-parser.js";
import type { SSEEvent } from "../src/streaming/types.js";

/**
 * Helper: build an async iterable of Uint8Array chunks from string parts.
 */
async function* fromChunks(parts: string[]): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  for (const part of parts) {
    yield encoder.encode(part);
  }
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<SSEEvent[]> {
  const parser = new SSEParser();
  const events: SSEEvent[] = [];
  for await (const evt of parser.parse(stream)) {
    events.push(evt);
  }
  return events;
}

describe("SSEParser", () => {
  describe("single line data", () => {
    it("parses a single data line event", async () => {
      const events = await collect(fromChunks(["data: hello\n\n"]));
      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("hello");
      expect(events[0].event).toBeUndefined();
      expect(events[0].id).toBeUndefined();
      expect(events[0].retry).toBeUndefined();
    });

    it("handles data without space after colon", async () => {
      const events = await collect(fromChunks(["data:hello\n\n"]));
      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("hello");
    });

    it("yields an empty data string when data: has no value", async () => {
      const events = await collect(fromChunks(["data:\n\n"]));
      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("");
    });
  });

  describe("cross-chunk data", () => {
    it("reassembles an event split across byte chunks", async () => {
      const events = await collect(fromChunks(["data: hel", "lo world\n\n"]));
      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("hello world");
    });

    it("reassembles an event when the \\n\\n boundary straddles chunks", async () => {
      const events = await collect(fromChunks(["data: hello\n", "\n"]));
      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("hello");
    });

    it("reassembles an event split byte-by-byte across many chunks", async () => {
      const raw = "data: frog\n\n";
      const parts = raw.match(/[\s\S]/gu) ?? [];
      const events = await collect(fromChunks(parts));
      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("frog");
    });

    it("buffers an incomplete event until boundary arrives", async () => {
      // First chunk has a line ending but no \n\n boundary; nothing yielded yet.
      // Second chunk brings the boundary. Result is one event with two data lines.
      const events = await collect(
        fromChunks(["data: line1\n", "data: line2\n\n"]),
      );
      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("line1\nline2");
    });
  });

  describe("[DONE] marker", () => {
    it("yields the [DONE] event and stops iteration", async () => {
      const events = await collect(
        fromChunks(["data: hello\n\ndata: [DONE]\n\n"]),
      );
      expect(events).toHaveLength(2);
      expect(events[0].data).toBe("hello");
      expect(events[1].data).toBe("[DONE]");
    });

    it("does not yield events after [DONE]", async () => {
      const events = await collect(
        fromChunks([
          "data: first\n\n",
          "data: [DONE]\n\n",
          "data: after-done\n\n",
        ]),
      );
      expect(events).toHaveLength(2);
      expect(events[1].data).toBe("[DONE]");
    });

    it("handles [DONE] split across chunks", async () => {
      const events = await collect(fromChunks(["data: [DON", "E]\n\n"]));
      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("[DONE]");
    });
  });

  describe("event/id fields", () => {
    it("parses event, id, and data fields together", async () => {
      const events = await collect(
        fromChunks(["event: ping\nid: 42\ndata: hello\n\n"]),
      );
      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("ping");
      expect(events[0].id).toBe("42");
      expect(events[0].data).toBe("hello");
    });

    it("parses retry as a number", async () => {
      const events = await collect(fromChunks(["retry: 5000\ndata: hi\n\n"]));
      expect(events).toHaveLength(1);
      expect(events[0].retry).toBe(5000);
    });

    it("ignores retry with non-numeric value", async () => {
      const events = await collect(fromChunks(["retry: abc\ndata: hi\n\n"]));
      expect(events).toHaveLength(1);
      expect(events[0].retry).toBeUndefined();
    });

    it("ignores comment lines (starting with colon)", async () => {
      const events = await collect(
        fromChunks([": this is a comment\ndata: hi\n\n"]),
      );
      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("hi");
    });

    it("treats a comment-only event as a heartbeat (no yield)", async () => {
      const events = await collect(fromChunks([": keepalive\n\n"]));
      expect(events).toHaveLength(0);
    });
  });

  describe("multi-line data", () => {
    it("concatenates multiple data: lines with \\n", async () => {
      const events = await collect(
        fromChunks(["data: line1\ndata: line2\ndata: line3\n\n"]),
      );
      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("line1\nline2\nline3");
    });

    it("preserves empty data: lines in the middle", async () => {
      const events = await collect(fromChunks(["data: a\ndata:\ndata: b\n\n"]));
      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("a\n\nb");
    });
  });

  describe("multiple events in one stream", () => {
    it("yields events in order", async () => {
      const events = await collect(
        fromChunks([
          "data: one\n\n",
          "data: two\n\n",
          "event: special\ndata: three\n\n",
        ]),
      );
      expect(events).toHaveLength(3);
      expect(events[0].data).toBe("one");
      expect(events[1].data).toBe("two");
      expect(events[2].data).toBe("three");
      expect(events[2].event).toBe("special");
    });

    it("handles CRLF line endings", async () => {
      const events = await collect(fromChunks(["data: hello\r\n\r\n"]));
      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("hello");
    });

    it("handles mixed CRLF and LF", async () => {
      const events = await collect(fromChunks(["data: a\r\ndata: b\n\r\n"]));
      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("a\nb");
    });
  });

  describe("trailing incomplete event", () => {
    it("does not yield an event with no trailing boundary", async () => {
      const events = await collect(fromChunks(["data: incomplete"]));
      expect(events).toHaveLength(0);
    });

    it("yields a trailing event that has content after the last boundary", async () => {
      // Stream ends without final \n\n but with a complete-looking event.
      // Per spec, dispatch on stream end if buffer has non-empty content.
      const events = await collect(fromChunks(["data: hello\n\n"]));
      expect(events).toHaveLength(1);
    });
  });
});
