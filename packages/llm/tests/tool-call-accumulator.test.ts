import { describe, expect, it } from "vitest";
import { ToolCallAccumulator } from "../src/streaming/tool-call-accumulator.js";
import type { ToolCall } from "../src/types/index.js";

describe("ToolCallAccumulator", () => {
  describe("single tool call accumulate", () => {
    it("accumulates id, name, and arguments into a complete ToolCall", () => {
      const acc = new ToolCallAccumulator();
      acc.add(0, { id: "call_1", name: "search" });
      acc.addArgumentsDelta(0, '{"query":"frog","top":3}');
      acc.complete();

      const all = acc.getAll();
      expect(all).toHaveLength(1);
      expect(all[0]).toEqual({
        id: "call_1",
        name: "search",
        arguments: { query: "frog", top: 3 },
      });
    });

    it("returns the same call via get(index)", () => {
      const acc = new ToolCallAccumulator();
      acc.add(0, { id: "call_1", name: "search" });
      acc.addArgumentsDelta(0, "{}");
      acc.complete();

      const call = acc.get(0);
      expect(call).toBeDefined();
      expect(call?.id).toBe("call_1");
      expect(call?.name).toBe("search");
    });
  });

  describe("multiple tool calls", () => {
    it("accumulates two tool calls at different indices", () => {
      const acc = new ToolCallAccumulator();
      acc.add(0, { id: "call_a", name: "search" });
      acc.add(1, { id: "call_b", name: "lookup" });
      acc.addArgumentsDelta(0, '{"q":"a"}');
      acc.addArgumentsDelta(1, '{"q":"b"}');
      acc.complete();

      const all = acc.getAll();
      expect(all).toHaveLength(2);
      expect(all[0].id).toBe("call_a");
      expect(all[0].name).toBe("search");
      expect(all[0].arguments).toEqual({ q: "a" });
      expect(all[1].id).toBe("call_b");
      expect(all[1].name).toBe("lookup");
      expect(all[1].arguments).toEqual({ q: "b" });
    });

    it("preserves insertion order via get(index) regardless of add order", () => {
      const acc = new ToolCallAccumulator();
      // Add index 1 first, then index 0
      acc.add(1, { id: "second", name: "b" });
      acc.add(0, { id: "first", name: "a" });
      acc.addArgumentsDelta(0, "{}");
      acc.addArgumentsDelta(1, "{}");
      acc.complete();

      expect(acc.get(0)?.id).toBe("first");
      expect(acc.get(1)?.id).toBe("second");
      // getAll returns sorted by index
      expect(acc.getAll()[0].id).toBe("first");
      expect(acc.getAll()[1].id).toBe("second");
    });

    it("returns undefined for get(missing index)", () => {
      const acc = new ToolCallAccumulator();
      acc.add(0, { id: "call_a", name: "search" });
      acc.addArgumentsDelta(0, "{}");
      acc.complete();

      expect(acc.get(0)).toBeDefined();
      expect(acc.get(99)).toBeUndefined();
    });
  });

  describe("arguments fragment concatenation", () => {
    it("concatenates multiple arguments deltas then JSON.parses on complete", () => {
      const acc = new ToolCallAccumulator();
      acc.add(0, { id: "call_1", name: "exec" });
      // Split a JSON object across many fragments
      acc.addArgumentsDelta(0, '{"command":"');
      acc.addArgumentsDelta(0, "git status");
      acc.addArgumentsDelta(0, '","args":[');
      acc.addArgumentsDelta(0, '"--short","--branch"');
      acc.addArgumentsDelta(0, "]}");
      acc.complete();

      const call = acc.get(0);
      expect(call?.arguments).toEqual({
        command: "git status",
        args: ["--short", "--branch"],
      });
    });

    it("produces an empty object when no arguments deltas were added", () => {
      const acc = new ToolCallAccumulator();
      acc.add(0, { id: "call_1", name: "noop" });
      acc.complete();

      const call = acc.get(0);
      expect(call?.arguments).toEqual({});
    });

    it("parses arguments containing nested objects and arrays", () => {
      const acc = new ToolCallAccumulator();
      acc.add(0, { id: "call_1", name: "search" });
      acc.addArgumentsDelta(0, '{"filter":{"tags":["a","b"]},"opts":null}');
      acc.complete();

      expect(acc.get(0)?.arguments).toEqual({
        filter: { tags: ["a", "b"] },
        opts: null,
      });
    });
  });

  describe("complete marker", () => {
    it("throws when getAll() is called before complete()", () => {
      const acc = new ToolCallAccumulator();
      acc.add(0, { id: "call_1", name: "search" });
      acc.addArgumentsDelta(0, "{}");
      expect(() => acc.getAll()).toThrowError(/complete/);
    });

    it("throws when get(index) is called before complete()", () => {
      const acc = new ToolCallAccumulator();
      acc.add(0, { id: "call_1", name: "search" });
      expect(() => acc.get(0)).toThrowError(/complete/);
    });

    it("returns results after complete()", () => {
      const acc = new ToolCallAccumulator();
      acc.add(0, { id: "call_1", name: "search" });
      acc.addArgumentsDelta(0, '{"q":"x"}');
      expect(() => acc.getAll()).toThrow();
      acc.complete();
      expect(acc.getAll()).toHaveLength(1);
    });

    it("complete() is idempotent", () => {
      const acc = new ToolCallAccumulator();
      acc.add(0, { id: "call_1", name: "search" });
      acc.addArgumentsDelta(0, "{}");
      acc.complete();
      acc.complete(); // second call is a no-op
      expect(acc.getAll()).toHaveLength(1);
    });

    it("throws when add() is called after complete()", () => {
      const acc = new ToolCallAccumulator();
      acc.add(0, { id: "call_1", name: "search" });
      acc.addArgumentsDelta(0, "{}");
      acc.complete();
      expect(() => acc.add(0, { id: "call_2", name: "noop" })).toThrowError(
        /complete/,
      );
    });

    it("throws when addArgumentsDelta() is called after complete()", () => {
      const acc = new ToolCallAccumulator();
      acc.add(0, { id: "call_1", name: "search" });
      acc.addArgumentsDelta(0, "{}");
      acc.complete();
      expect(() => acc.addArgumentsDelta(0, "{}")).toThrowError(/complete/);
    });
  });

  describe("returns a defensive copy", () => {
    it("getAll() returns a new array each call", () => {
      const acc = new ToolCallAccumulator();
      acc.add(0, { id: "call_1", name: "search" });
      acc.addArgumentsDelta(0, "{}");
      acc.complete();

      const a = acc.getAll();
      const b = acc.getAll();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });

    it("ToolCall type contract: returned objects satisfy ToolCall", () => {
      const acc = new ToolCallAccumulator();
      acc.add(0, { id: "call_1", name: "search" });
      acc.addArgumentsDelta(0, '{"q":"x"}');
      acc.complete();

      const calls: ToolCall[] = acc.getAll();
      expect(calls[0].id).toBe("call_1");
      expect(calls[0].name).toBe("search");
      expect(calls[0].arguments).toEqual({ q: "x" });
    });
  });
});
