export type PermissionDecision = "allow" | "deny" | "ask";

export interface PermissionRule {
  toolId: string;
  args?: unknown;
  decision: PermissionDecision;
  reason?: string;
  expiresAt?: number;
}
