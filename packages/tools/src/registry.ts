import type { LLMToolDefinition, ToolDefinition } from "./definition.js";
import { toLLMTool } from "./definition.js";

export class ToolAlreadyRegisteredError extends Error {
  readonly toolId: string;
  constructor(toolId: string) {
    super(`Tool already registered: "${toolId}"`);
    this.name = "ToolAlreadyRegisteredError";
    this.toolId = toolId;
  }
}

export class ToolNotFoundError extends Error {
  readonly toolId: string;
  constructor(toolId: string) {
    super(`Tool not found: "${toolId}"`);
    this.name = "ToolNotFoundError";
    this.toolId = toolId;
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(def: ToolDefinition): void {
    if (this.tools.has(def.id)) {
      throw new ToolAlreadyRegisteredError(def.id);
    }
    // Re-validate (defensive — createTool already validated, but registry may receive hand-built defs)
    if (typeof def.execute !== "function") {
      throw new Error(`Tool "${def.id}" execute must be a function`);
    }
    if (typeof def.id !== "string" || def.id.length === 0) {
      throw new Error("Tool id must be a non-empty string");
    }
    this.tools.set(def.id, def);
  }

  unregister(id: string): boolean {
    return this.tools.delete(id);
  }

  get(id: string): ToolDefinition | undefined {
    return this.tools.get(id);
  }

  has(id: string): boolean {
    return this.tools.has(id);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  listByTag(tag: string): ToolDefinition[] {
    return this.list().filter((t) => t.tags.includes(tag));
  }

  toLLMTools(filter?: string[]): LLMToolDefinition[] {
    const all = this.list();
    const selected = filter ? all.filter((t) => filter.includes(t.id)) : all;
    return selected.map((t) => toLLMTool(t));
  }

  clear(): void {
    this.tools.clear();
  }

  get size(): number {
    return this.tools.size;
  }
}
