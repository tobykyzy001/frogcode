import type { ToolContext } from "../context.js";
import type { ToolDefinition } from "../definition.js";
import type { PermissionRule } from "../permission/rule.js";

export interface MockPermissionDecision {
  allowed: boolean;
  reason?: string;
  persisted?: boolean;
}

export interface MockPermissionEngineConfig {
  defaultDecision?: MockPermissionDecision;
  decisionsByToolId?: Record<string, MockPermissionDecision>;
  callsLog?: Array<{ toolId: string; input: unknown }>;
}

export interface PermissionEngineLike {
  check(
    tool: ToolDefinition,
    input: unknown,
    ctx: ToolContext,
  ): Promise<MockPermissionDecision>;
  addRule(rule: PermissionRule): void;
  removeRule(index: number): void;
  listRules(): PermissionRule[];
}

export function createMockPermissionEngine(
  config: MockPermissionEngineConfig = {},
): PermissionEngineLike {
  const defaultDecision = config.defaultDecision ?? { allowed: true };
  const rules: PermissionRule[] = [];

  return {
    async check(
      tool: ToolDefinition,
      input: unknown,
      _ctx: ToolContext,
    ): Promise<MockPermissionDecision> {
      if (config.callsLog) {
        config.callsLog.push({ toolId: tool.id, input });
      }
      const override = config.decisionsByToolId?.[tool.id];
      if (override) {
        return override;
      }
      return defaultDecision;
    },
    addRule(rule: PermissionRule): void {
      rules.push(rule);
    },
    removeRule(index: number): void {
      rules.splice(index, 1);
    },
    listRules(): PermissionRule[] {
      return [...rules];
    },
  };
}
