import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AjvAdapter } from "../src/schema/ajv-adapter.js";
import type {
  SchemaValidator,
  ValidationError,
  ValidationResult,
} from "../src/schema/types.js";
import {
  ValidationChain,
  ValidationExhaustedError,
} from "../src/schema/validation-chain.js";
import { ZodAdapter } from "../src/schema/zod-adapter.js";

describe("SchemaValidator interface", () => {
  it("can be implemented as a plain object", () => {
    const validator: SchemaValidator = {
      validate: (data) => ({ valid: true, errors: [], data }),
    };
    const result = validator.validate({ foo: "bar" });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.data).toEqual({ foo: "bar" });
  });

  it("ValidationResult carries errors and optional data", () => {
    const ok: ValidationResult = { valid: true, errors: [], data: 42 };
    const bad: ValidationResult = {
      valid: false,
      errors: [
        {
          path: "name",
          message: "expected string",
          expected: "string",
          received: "number",
        },
      ],
    };
    expect(ok.valid).toBe(true);
    expect(ok.data).toBe(42);
    expect(bad.valid).toBe(false);
    expect(bad.data).toBeUndefined();
    expect(bad.errors[0]?.path).toBe("name");
  });

  it("ValidationError has all four required fields", () => {
    const err: ValidationError = {
      path: "user.age",
      message: "must be a number",
      expected: "number",
      received: "string",
    };
    expect(err.path).toBe("user.age");
    expect(err.message).toBe("must be a number");
    expect(err.expected).toBe("number");
    expect(err.received).toBe("string");
  });
});

describe("ZodAdapter", () => {
  const schema = z.object({
    name: z.string(),
    age: z.number(),
  });

  it("returns valid result with coerced data on success", () => {
    const adapter = new ZodAdapter(schema);
    const result = adapter.validate({ name: "Alice", age: 30 });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.data).toEqual({ name: "Alice", age: 30 });
  });

  it("returns errors with path/message/expected/received on invalid input", () => {
    const adapter = new ZodAdapter(schema);
    const result = adapter.validate({ name: 123, age: "old" });
    expect(result.valid).toBe(false);
    expect(result.data).toBeUndefined();
    expect(result.errors).toHaveLength(2);
    const paths = result.errors.map((e) => e.path);
    expect(paths).toContain("name");
    expect(paths).toContain("age");
    for (const err of result.errors) {
      expect(typeof err.path).toBe("string");
      expect(typeof err.message).toBe("string");
      expect(typeof err.expected).toBe("string");
      expect(typeof err.received).toBe("string");
    }
  });

  it("maps invalid_type errors to expected/received type strings", () => {
    const adapter = new ZodAdapter(schema);
    const result = adapter.validate({ name: 123, age: 30 });
    expect(result.valid).toBe(false);
    const nameErr = result.errors.find((e) => e.path === "name");
    expect(nameErr).toBeDefined();
    expect(nameErr?.expected).toBe("string");
    expect(nameErr?.received).toBe("number");
  });

  it("reports a non-empty path marker when top-level shape is wrong", () => {
    const adapter = new ZodAdapter(schema);
    const result = adapter.validate("not-an-object");
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.path.length).toBeGreaterThan(0);
  });

  it("deep clones data before validation (P1-Q6 fix)", () => {
    // A transform that mutates the parsed value reference. If the adapter
    // failed to clone, the mutation would leak into `original`.
    const mutatingSchema = z.object({ foo: z.string() }).transform((val) => {
      (val as { foo: string; mutated?: boolean }).mutated = true;
      return val;
    });
    const adapter = new ZodAdapter(mutatingSchema);
    const original: { foo: string } = { foo: "bar" };
    const result = adapter.validate(original);
    expect(result.valid).toBe(true);
    expect(original).toEqual({ foo: "bar" });
    expect(original).not.toHaveProperty("mutated");
    expect(result.data).toEqual({ foo: "bar", mutated: true });
  });

  it("returns coerced data distinct from the input reference", () => {
    const adapter = new ZodAdapter(schema);
    const original = { name: "Alice", age: 30 };
    const result = adapter.validate(original);
    expect(result.valid).toBe(true);
    expect(result.data).not.toBe(original);
    expect(result.data).toEqual(original);
  });

  it("deep-clones nested objects: mutating returned data leaves original untouched", () => {
    const adapter = new ZodAdapter(
      z.object({ nested: z.object({ a: z.string() }) }),
    );
    const input = { nested: { a: "x" } };
    const result = adapter.validate(input);
    expect(result.valid).toBe(true);
    const returned = result.data as { nested: { a: string } };
    expect(returned).not.toBe(input);
    expect(returned.nested).not.toBe(input.nested);
    returned.nested.a = "MUTATED";
    expect(input.nested.a).toBe("x");
  });
});

describe("AjvAdapter", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "number" },
    },
    required: ["name", "age"],
    additionalProperties: false,
  };

  it("returns valid result with data on success", () => {
    const adapter = new AjvAdapter(schema);
    const result = adapter.validate({ name: "Alice", age: 30 });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.data).toEqual({ name: "Alice", age: 30 });
  });

  it("returns errors with all four fields on invalid input", () => {
    const adapter = new AjvAdapter(schema);
    const result = adapter.validate({ name: 123 });
    expect(result.valid).toBe(false);
    expect(result.data).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
    for (const err of result.errors) {
      expect(typeof err.path).toBe("string");
      expect(typeof err.message).toBe("string");
      expect(typeof err.expected).toBe("string");
      expect(typeof err.received).toBe("string");
    }
  });

  it("reports required-key errors for missing properties", () => {
    const adapter = new AjvAdapter(schema);
    const result = adapter.validate({});
    expect(result.valid).toBe(false);
    const messages = result.errors.map((e) => e.message).join(" ");
    expect(messages.toLowerCase()).toContain("required");
  });

  it("maps type-mismatch errors to expected/received type strings", () => {
    const adapter = new AjvAdapter({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
    const result = adapter.validate({ name: 123 });
    expect(result.valid).toBe(false);
    const typeErr = result.errors.find((e) => e.expected === "string");
    expect(typeErr).toBeDefined();
    expect(typeErr?.received).toBe("number");
  });

  it("deep clones data before validation (P1-Q6 fix)", () => {
    const adapter = new AjvAdapter(schema);
    const original = { name: "Alice", age: 30 };
    const result = adapter.validate(original);
    expect(result.valid).toBe(true);
    expect(result.data).not.toBe(original);
    expect(result.data).toEqual(original);
    (result.data as { name: string }).name = "MUTATED";
    expect(original.name).toBe("Alice");
  });

  it("deep-clones nested input: mutating returned data leaves original untouched", () => {
    const adapter = new AjvAdapter({
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
      },
      required: ["nested"],
    });
    const input = { nested: { a: "x" } };
    const result = adapter.validate(input);
    expect(result.valid).toBe(true);
    const returned = result.data as { nested: { a: string } };
    expect(returned).not.toBe(input);
    expect(returned.nested).not.toBe(input.nested);
    returned.nested.a = "MUTATED";
    expect(input.nested.a).toBe("x");
  });

  it("does not mutate the input when validation fails", () => {
    const adapter = new AjvAdapter(schema);
    const original = { name: 123 };
    const snapshot = { ...original };
    adapter.validate(original);
    expect(original).toEqual(snapshot);
  });
});

describe("ValidationChain", () => {
  it("returns data immediately when validation succeeds", async () => {
    const validator: SchemaValidator = {
      validate: (data) => ({ valid: true, errors: [], data }),
    };
    const chain = new ValidationChain({ validator, maxAttempts: 3 });
    const retryFn = vi.fn<(errors: ValidationError[]) => Promise<unknown>>();
    const result = await chain.validateWithRetry({ foo: "bar" }, retryFn);
    expect(result).toEqual({ foo: "bar" });
    expect(retryFn).not.toHaveBeenCalled();
  });

  it("retries via retryFn and succeeds on the second attempt", async () => {
    let callCount = 0;
    const validator: SchemaValidator = {
      validate: (data) => {
        callCount += 1;
        if (callCount === 1) {
          return {
            valid: false,
            errors: [
              {
                path: "foo",
                message: "missing",
                expected: "string",
                received: "undefined",
              },
            ],
          };
        }
        return { valid: true, errors: [], data };
      },
    };
    const chain = new ValidationChain({ validator, maxAttempts: 3 });
    const retryFn = vi
      .fn<(errors: ValidationError[]) => Promise<unknown>>()
      .mockResolvedValue({ foo: "fixed" });
    const result = await chain.validateWithRetry({ foo: "bad" }, retryFn);
    expect(result).toEqual({ foo: "fixed" });
    expect(retryFn).toHaveBeenCalledTimes(1);
    expect(retryFn.mock.calls[0]?.[0]).toEqual([
      {
        path: "foo",
        message: "missing",
        expected: "string",
        received: "undefined",
      },
    ]);
  });

  it("throws ValidationExhaustedError when maxAttempts is reached", async () => {
    const errors: ValidationError[] = [
      {
        path: "foo",
        message: "missing",
        expected: "string",
        received: "undefined",
      },
    ];
    const validator: SchemaValidator = {
      validate: () => ({ valid: false, errors }),
    };
    const chain = new ValidationChain({ validator, maxAttempts: 2 });
    const retryFn = vi
      .fn<(errors: ValidationError[]) => Promise<unknown>>()
      .mockResolvedValue({ foo: "still bad" });
    await expect(
      chain.validateWithRetry({ foo: "bad" }, retryFn),
    ).rejects.toThrow(ValidationExhaustedError);
    // maxAttempts=2 => 2 validation attempts, 1 retryFn call between them.
    expect(retryFn).toHaveBeenCalledTimes(1);
  });

  it("does not call retryFn when maxAttempts is 1", async () => {
    const validator: SchemaValidator = {
      validate: () => ({
        valid: false,
        errors: [
          {
            path: "x",
            message: "bad",
            expected: "y",
            received: "z",
          },
        ],
      }),
    };
    const chain = new ValidationChain({ validator, maxAttempts: 1 });
    const retryFn = vi
      .fn<(errors: ValidationError[]) => Promise<unknown>>()
      .mockResolvedValue({});
    await expect(
      chain.validateWithRetry({ foo: "bar" }, retryFn),
    ).rejects.toThrow(ValidationExhaustedError);
    expect(retryFn).not.toHaveBeenCalled();
  });

  it("carries the last errors and attempt count on exhaustion", async () => {
    const errors: ValidationError[] = [
      {
        path: "x",
        message: "bad",
        expected: "y",
        received: "z",
      },
    ];
    const validator: SchemaValidator = {
      validate: () => ({ valid: false, errors }),
    };
    const chain = new ValidationChain({ validator, maxAttempts: 3 });
    const retryFn = vi
      .fn<(errors: ValidationError[]) => Promise<unknown>>()
      .mockResolvedValue({});
    let caught: ValidationExhaustedError | undefined;
    try {
      await chain.validateWithRetry({ foo: "bar" }, retryFn);
      expect.fail("should have thrown ValidationExhaustedError");
    } catch (err) {
      caught = err as ValidationExhaustedError;
    }
    expect(caught).toBeInstanceOf(ValidationExhaustedError);
    expect(caught?.lastErrors).toEqual(errors);
    expect(caught?.attempts).toBe(3);
  });

  it("ValidationExhaustedError satisfies the retryExhausted marker", async () => {
    const validator: SchemaValidator = {
      validate: () => ({
        valid: false,
        errors: [
          {
            path: "x",
            message: "bad",
            expected: "y",
            received: "z",
          },
        ],
      }),
    };
    const chain = new ValidationChain({ validator, maxAttempts: 1 });
    try {
      await chain.validateWithRetry({ foo: "bar" }, async () => ({}));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationExhaustedError);
      const marker = err as { readonly retryExhausted: true };
      expect(marker.retryExhausted).toBe(true);
    }
  });

  it("deep clones data before each validation (P1-Q6 fix)", async () => {
    const validator: SchemaValidator = {
      validate: (data) => {
        (data as { mutated?: boolean }).mutated = true;
        return { valid: true, errors: [], data };
      },
    };
    const chain = new ValidationChain({ validator, maxAttempts: 3 });
    const original = { foo: "bar" };
    const result = await chain.validateWithRetry(original, async () => ({}));
    expect(original).toEqual({ foo: "bar" });
    expect(original).not.toHaveProperty("mutated");
    expect(result).toHaveProperty("mutated", true);
  });

  it("deep clones each retryFn output before re-validating", async () => {
    let validatedInput: unknown;
    const validator: SchemaValidator = {
      validate: (data) => {
        validatedInput = data;
        (data as { tagged?: boolean }).tagged = true;
        return { valid: false, errors: [] as ValidationError[] };
      },
    };
    const chain = new ValidationChain({ validator, maxAttempts: 2 });
    const retryOutput = { value: 1 };
    const retryFn = vi
      .fn<(errors: ValidationError[]) => Promise<unknown>>()
      .mockResolvedValue(retryOutput);
    await expect(
      chain.validateWithRetry({ initial: true }, retryFn),
    ).rejects.toThrow(ValidationExhaustedError);
    expect(retryOutput).toEqual({ value: 1 });
    expect(retryOutput).not.toHaveProperty("tagged");
    expect(validatedInput).toHaveProperty("tagged", true);
  });

  it("passes the last attempt's errors to retryFn on each retry", async () => {
    const firstErrors: ValidationError[] = [
      { path: "a", message: "first", expected: "x", received: "y" },
    ];
    const secondErrors: ValidationError[] = [
      { path: "b", message: "second", expected: "x", received: "y" },
    ];
    let callCount = 0;
    const validator: SchemaValidator = {
      validate: () => {
        callCount += 1;
        return {
          valid: false,
          errors: callCount === 1 ? firstErrors : secondErrors,
        };
      },
    };
    const chain = new ValidationChain({ validator, maxAttempts: 3 });
    const retryFn = vi
      .fn<(errors: ValidationError[]) => Promise<unknown>>()
      .mockResolvedValue({ ok: false });
    await expect(
      chain.validateWithRetry({ start: true }, retryFn),
    ).rejects.toThrow(ValidationExhaustedError);
    expect(retryFn).toHaveBeenCalledTimes(2);
    expect(retryFn.mock.calls[0]?.[0]).toEqual(firstErrors);
    expect(retryFn.mock.calls[1]?.[0]).toEqual(secondErrors);
  });
});

describe("ValidationExhaustedError", () => {
  it("extends Error and sets the name", () => {
    const err = new ValidationExhaustedError([], 1);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ValidationExhaustedError");
  });

  it("implements the retryExhausted structural marker", () => {
    const err = new ValidationExhaustedError([], 1);
    expect(err.retryExhausted).toBe(true);
    const marker: { readonly retryExhausted: true } = err;
    expect(marker.retryExhausted).toBe(true);
  });

  it("carries lastErrors and attempts", () => {
    const errors: ValidationError[] = [
      {
        path: "a.b",
        message: "boom",
        expected: "string",
        received: "number",
      },
    ];
    const err = new ValidationExhaustedError(errors, 5);
    expect(err.lastErrors).toBe(errors);
    expect(err.attempts).toBe(5);
    expect(err.message).toContain("5");
  });
});
