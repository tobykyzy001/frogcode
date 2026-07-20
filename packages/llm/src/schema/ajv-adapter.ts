import { Ajv, type ErrorObject } from "ajv";
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

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function valueAtInstancePath(data: unknown, instancePath: string): unknown {
  if (instancePath === "") return data;
  const segments = instancePath.split("/").slice(1);
  let cursor: unknown = data;
  for (const segment of segments) {
    if (cursor == null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[decodeURIComponent(segment)];
  }
  return cursor;
}

function describeExpected(err: ErrorObject): string {
  const params = err.params as Record<string, unknown>;
  switch (err.keyword) {
    case "type":
      return typeof params.type === "string"
        ? params.type
        : Array.isArray(params.type)
          ? params.type.join("|")
          : err.keyword;
    case "required":
      return typeof params.missingProperty === "string"
        ? `presence of ${params.missingProperty}`
        : err.keyword;
    case "format":
      return typeof params.format === "string" ? params.format : err.keyword;
    default:
      return err.keyword;
  }
}

function mapError(err: ErrorObject, data: unknown): ValidationError {
  const received = describeValue(valueAtInstancePath(data, err.instancePath));
  return {
    path: err.instancePath || "(root)",
    message: err.message ?? `failed keyword "${err.keyword}"`,
    expected: describeExpected(err),
    received,
  };
}

export class AjvAdapter implements SchemaValidator {
  private readonly ajv: Ajv;
  private readonly schema: object;

  constructor(schema: object) {
    this.ajv = new Ajv();
    this.schema = schema;
  }

  validate(data: unknown): ValidationResult {
    const cloned = deepClone(data);
    const valid = this.ajv.validate(this.schema, cloned);
    if (valid) {
      return { valid: true, errors: [], data: cloned };
    }
    const errors = (this.ajv.errors ?? []).map((err) => mapError(err, cloned));
    return { valid: false, errors };
  }
}
