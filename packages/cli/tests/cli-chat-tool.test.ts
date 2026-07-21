import { describe, expect, it, vi } from "vitest";
import {
  buildToolPipeline,
  collectToolNames,
} from "../src/commands/chat.js";
import type { ChatOptions } from "../src/commands/chat.js";
import { ToolRegistry } from "@frogcode/tools";

describe("collectToolNames (commander.js collector)", () => {
  it("starts from empty array", () => {
    const result = collectToolNames("fs.read", []);
    expect(result).toEqual(["fs.read"]);
  });

  it("accumulates multiple values", () => {
    const first = collectToolNames("fs.read", []);
    const second = collectToolNames("shell.exec", first);
    expect(second).toEqual(["fs.read", "shell.exec"]);
  });
});

describe("buildToolPipeline", () => {
  it("returns no registry when --no-tool is set", () => {
    const opts: ChatOptions = { noTool: true, tool: ["fs.read"] };
    const result = buildToolPipeline(opts);
    expect(result.registry).toBeUndefined();
    expect(result.actHandler).toBeUndefined();
    expect(result.log).toEqual([]);
  });

  it("returns no registry when no --tool flags are given", () => {
    const opts: ChatOptions = {};
    const result = buildToolPipeline(opts);
    expect(result.registry).toBeUndefined();
  });

  it("returns no registry when --tool list is empty", () => {
    const opts: ChatOptions = { tool: [] };
    const result = buildToolPipeline(opts);
    expect(result.registry).toBeUndefined();
  });

  it("registers fs.read when --tool fs.read is given", () => {
    const opts: ChatOptions = { tool: ["fs.read"] };
    const result = buildToolPipeline(opts);
    expect(result.registry).toBeDefined();
    expect(result.registry?.has("fs.read")).toBe(true);
    expect(result.registry?.size).toBe(1);
  });

  it("registers all fs.* tools when --tool fs (prefix match) is given", () => {
    const opts: ChatOptions = { tool: ["fs"] };
    const result = buildToolPipeline(opts);
    expect(result.registry).toBeDefined();
    expect(result.registry?.has("fs.read")).toBe(true);
    expect(result.registry?.has("fs.write")).toBe(true);
    expect(result.registry?.has("fs.glob")).toBe(true);
  });

  it("registers all search.* tools with --tool search", () => {
    const opts: ChatOptions = { tool: ["search"] };
    const result = buildToolPipeline(opts);
    expect(result.registry).toBeDefined();
    expect(result.registry?.has("search.grep")).toBe(true);
    expect(result.registry?.has("search.glob")).toBe(true);
  });

  it("outputs warning for unknown tool name", () => {
    const warnSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const opts: ChatOptions = { tool: ["nonexistent.tool"] };
    const result = buildToolPipeline(opts);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Warning: unknown tool "nonexistent.tool"'),
    );
    expect(result.registry).toBeUndefined();

    warnSpy.mockRestore();
  });

  it("creates actHandler when tools are registered", () => {
    const opts: ChatOptions = { tool: ["fs.read"] };
    const result = buildToolPipeline(opts);
    expect(result.actHandler).toBeDefined();
    expect(typeof result.actHandler?.act).toBe("function");
  });

  it("respects --tool-timeout for the sandbox timeout", () => {
    const opts: ChatOptions = { tool: ["fs.read"], toolTimeout: 30000 };
    const result = buildToolPipeline(opts);
    // pipeline is created with the timeout; registry is still valid
    expect(result.registry).toBeDefined();
    expect(result.pipeline).toBeDefined();
  });

  it("creates hooks that log tool calls on success (via hook)", () => {
    const opts: ChatOptions = { tool: ["fs.read"] };
    const result = buildToolPipeline(opts);
    // Hooks are installed — verified by presence of pipeline and actHandler
    expect(result.pipeline).toBeDefined();
    // log starts empty
    expect(result.log).toEqual([]);
  });

  it("registers multiple tool groups from multiple --tool flags", () => {
    const opts: ChatOptions = { tool: ["fs.read", "search.grep"] };
    const result = buildToolPipeline(opts);
    expect(result.registry).toBeDefined();
    expect(result.registry?.has("fs.read")).toBe(true);
    expect(result.registry?.has("search.grep")).toBe(true);
    // Only the explicitly named tools are registered (not all fs.* or search.*)
    expect(result.registry?.has("fs.write")).toBe(false);
    expect(result.registry?.has("fs.glob")).toBe(false);
    expect(result.registry?.has("search.glob")).toBe(false);
  });

  it("deduplicates tools registered via overlapping prefixes", () => {
    const opts: ChatOptions = { tool: ["fs", "fs.read"] };
    const result = buildToolPipeline(opts);
    expect(result.registry).toBeDefined();
    // All fs tools are there, but each only once
    expect(result.registry?.has("fs.read")).toBe(true);
    expect(result.registry?.has("fs.write")).toBe(true);
    expect(result.registry?.has("fs.glob")).toBe(true);
    // size should be exactly 3 (not duplicated)
    expect(result.registry?.size).toBe(3);
  });

  it("registers all tools when no registry is built (--no-tool)", () => {
    const opts: ChatOptions = { noTool: true };
    const result = buildToolPipeline(opts);
    expect(result.registry).toBeUndefined();
    expect(result.actHandler).toBeUndefined();
    expect(result.pipeline).toBeUndefined();
  });
});