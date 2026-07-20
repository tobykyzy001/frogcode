import type { ZodError, ZodIssue, ZodSchema } from "zod";
import type {
  SchemaValidator,
  ValidationError,
  ValidationResult,
} from "./types.js";

function deepClone<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function formatPath(path: (string | number)[]): string {
  return path.map(String).join(".") || "(root)";
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function valueAtPath(data: unknown, path: (string | number)[]): unknown {
  let cursor: unknown = data;
  for (const segment of path) {
    if (cursor == null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string | number, unknown>)[segment];
  }
  return cursor;
}

function mapIssue(issue: ZodIssue, data: unknown): ValidationError {
  const path = formatPath(issue.path);
  if (issue.code === "invalid_type") {
    return {
      path,
      message: issue.message,
      expected: issue.expected,
      received: issue.received,
    };
  }
  const received = describeValue(valueAtPath(data, issue.path));
  return {
    path,
    message: issue.message,
    expected: issue.code,
    received,
  };
}

export class ZodAdapter implements SchemaValidator {
  constructor(private readonly schema: ZodSchema) {}

  validate(data: unknown): ValidationResult {
    const cloned = deepClone(data);
    const parsed = this.schema.safeParse(cloned);
    if (parsed.success) {
      return { valid: true, errors: [], data: parsed.data };
    }
    const errors = (parsed.error as ZodError).issues.map((issue) =>
      mapIssue(issue, cloned),
    );
    return { valid: false, errors };
  }
}
