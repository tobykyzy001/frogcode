import type { z } from "zod";

export type JsonSchemaPrimitive =
  | {
      type: "string";
      enum?: string[];
      minLength?: number;
      maxLength?: number;
      format?: string;
      description?: string;
    }
  | {
      type: "number" | "integer";
      minimum?: number;
      maximum?: number;
      description?: string;
    }
  | { type: "boolean"; description?: string }
  | { type: "null"; description?: string };

export interface JsonSchemaObject {
  type: "object";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: JsonSchema | boolean;
  description?: string;
}

export interface JsonSchemaArray {
  type: "array";
  items: JsonSchema;
  description?: string;
}

export type JsonSchema =
  | JsonSchemaPrimitive
  | JsonSchemaObject
  | JsonSchemaArray;

interface ZodDefBase {
  typeName?: string;
  description?: string;
}

interface ZodObjectDef extends ZodDefBase {
  typeName: "ZodObject";
  shape: () => Record<string, z.ZodTypeAny>;
}

interface ZodStringDef extends ZodDefBase {
  typeName: "ZodString";
  checks?: Array<{ kind: string; value?: number }>;
}

interface ZodNumberDef extends ZodDefBase {
  typeName: "ZodNumber";
  checks?: Array<{ kind: string; value?: number }>;
}

interface ZodBooleanDef extends ZodDefBase {
  typeName: "ZodBoolean";
}

interface ZodArrayDef extends ZodDefBase {
  typeName: "ZodArray";
  type: z.ZodTypeAny;
}

interface ZodEnumDef extends ZodDefBase {
  typeName: "ZodEnum";
  values: readonly [string, ...string[]];
}

interface ZodOptionalDef extends ZodDefBase {
  typeName: "ZodOptional";
  innerType: z.ZodTypeAny;
}

interface ZodDefaultDef extends ZodDefBase {
  typeName: "ZodDefault";
  innerType: z.ZodTypeAny;
  defaultValue: () => unknown;
}

interface ZodRecordDef extends ZodDefBase {
  typeName: "ZodRecord";
  valueType: z.ZodTypeAny;
}

interface ZodEffectsDef extends ZodDefBase {
  typeName: "ZodEffects";
  schema: z.ZodTypeAny;
}

type ZodDef =
  | ZodObjectDef
  | ZodStringDef
  | ZodNumberDef
  | ZodBooleanDef
  | ZodArrayDef
  | ZodEnumDef
  | ZodOptionalDef
  | ZodDefaultDef
  | ZodRecordDef
  | ZodEffectsDef;

function getDef(schema: z.ZodTypeAny): ZodDef {
  return schema._def as unknown as ZodDef;
}

function extractDescription(def: ZodDef): string | undefined {
  return def.description;
}

function convertString(def: ZodStringDef): JsonSchema {
  const result: {
    type: "string";
    enum?: string[];
    minLength?: number;
    maxLength?: number;
    format?: string;
    description?: string;
  } = {
    type: "string",
  };
  for (const check of def.checks ?? []) {
    switch (check.kind) {
      case "min":
        if (check.value !== undefined) {
          result.minLength = check.value;
        }
        break;
      case "max":
        if (check.value !== undefined) {
          result.maxLength = check.value;
        }
        break;
      case "email":
        result.format = "email";
        break;
      case "url":
        result.format = "uri";
        break;
      default:
        break;
    }
  }
  const description = extractDescription(def);
  if (description !== undefined) {
    result.description = description;
  }
  return result;
}

function convertNumber(def: ZodNumberDef): JsonSchema {
  const isInt = (def.checks ?? []).some((c) => c.kind === "int");
  const result: {
    type: "number" | "integer";
    minimum?: number;
    maximum?: number;
    description?: string;
  } = {
    type: isInt ? "integer" : "number",
  };
  for (const check of def.checks ?? []) {
    if (check.value === undefined) {
      continue;
    }
    switch (check.kind) {
      case "min":
        result.minimum = check.value;
        break;
      case "max":
        result.maximum = check.value;
        break;
      default:
        break;
    }
  }
  const description = extractDescription(def);
  if (description !== undefined) {
    result.description = description;
  }
  return result;
}

function convertObject(def: ZodObjectDef): JsonSchemaObject {
  const shape = def.shape();
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    const valueDef = getDef(value);
    const isOptional =
      valueDef.typeName === "ZodOptional" || valueDef.typeName === "ZodDefault";
    properties[key] = zodToJsonSchema(value);
    if (!isOptional) {
      required.push(key);
    }
  }
  const result: JsonSchemaObject = {
    type: "object",
    properties,
  };
  if (required.length > 0) {
    result.required = required;
  }
  const description = extractDescription(def);
  if (description !== undefined) {
    result.description = description;
  }
  return result;
}

export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const rawTypeName = (schema._def as { typeName?: unknown }).typeName;
  const def = getDef(schema);
  switch (def.typeName) {
    case "ZodObject":
      return convertObject(def);
    case "ZodString":
      return convertString(def);
    case "ZodNumber":
      return convertNumber(def);
    case "ZodBoolean": {
      const result: { type: "boolean"; description?: string } = {
        type: "boolean",
      };
      const description = extractDescription(def);
      if (description !== undefined) {
        result.description = description;
      }
      return result;
    }
    case "ZodArray": {
      const result: JsonSchemaArray = {
        type: "array",
        items: zodToJsonSchema(def.type),
      };
      const description = extractDescription(def);
      if (description !== undefined) {
        result.description = description;
      }
      return result;
    }
    case "ZodEnum": {
      const result: { type: "string"; enum: string[]; description?: string } = {
        type: "string",
        enum: [...def.values],
      };
      const description = extractDescription(def);
      if (description !== undefined) {
        result.description = description;
      }
      return result;
    }
    case "ZodOptional":
      return zodToJsonSchema(def.innerType);
    case "ZodDefault":
      return zodToJsonSchema(def.innerType);
    case "ZodRecord": {
      const result: JsonSchemaObject = {
        type: "object",
        additionalProperties: zodToJsonSchema(def.valueType),
      };
      const description = extractDescription(def);
      if (description !== undefined) {
        result.description = description;
      }
      return result;
    }
    case "ZodEffects":
      return zodToJsonSchema(def.schema);
    default:
      throw new Error(
        `Unsupported Zod type: ${String(rawTypeName)} (zod-to-json-schema only supports object, string, number, boolean, array, enum, optional, default, record, effects)`,
      );
  }
}
