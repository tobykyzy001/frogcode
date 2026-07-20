import { describe, expect, it } from "vitest";
import { PromptTemplateError } from "../src/prompt/errors.js";
import { PromptTemplate } from "../src/prompt/template.js";

describe("PromptTemplate.compile", () => {
  it("returns a PromptTemplate instance", () => {
    const tpl = PromptTemplate.compile("Hello {{name}}");
    expect(tpl).toBeInstanceOf(PromptTemplate);
  });

  it("exposes a render method", () => {
    const tpl = PromptTemplate.compile("Hi");
    expect(typeof tpl.render).toBe("function");
  });
});

describe("PromptTemplate.render — variable interpolation", () => {
  it("interpolates a single variable", () => {
    const tpl = PromptTemplate.compile("Hello {{name}}");
    expect(tpl.render({ name: "Alice" })).toBe("Hello Alice");
  });

  it("interpolates multiple variables", () => {
    const tpl = PromptTemplate.compile(
      "Hello {{name}}, you are {{age}} years old",
    );
    expect(tpl.render({ name: "Alice", age: 30 })).toBe(
      "Hello Alice, you are 30 years old",
    );
  });

  it("renders plain text without any variables verbatim", () => {
    const tpl = PromptTemplate.compile("no variables here");
    expect(tpl.render({})).toBe("no variables here");
  });

  it("coerces non-string values to strings", () => {
    const tpl = PromptTemplate.compile("count={{n}} ok={{ok}}");
    expect(tpl.render({ n: 42, ok: true })).toBe("count=42 ok=true");
  });
});

describe("PromptTemplate.render — nested dot-paths", () => {
  it("resolves a top-level nested object", () => {
    const tpl = PromptTemplate.compile("User: {{user.name}} ({{user.role}})");
    expect(tpl.render({ user: { name: "Bob", role: "admin" } })).toBe(
      "User: Bob (admin)",
    );
  });

  it("resolves a deeply nested path", () => {
    const tpl = PromptTemplate.compile("{{a.b.c}}");
    expect(tpl.render({ a: { b: { c: "deep" } } })).toBe("deep");
  });

  it("mixes nested and flat variables in one template", () => {
    const tpl = PromptTemplate.compile("{{greeting}}, {{user.name}}!");
    expect(tpl.render({ greeting: "Hi", user: { name: "Carol" } })).toBe(
      "Hi, Carol!",
    );
  });
});

describe("PromptTemplate.render — conditionals", () => {
  it("renders the conditional body when the variable is truthy", () => {
    const tpl = PromptTemplate.compile("Hello{{#if vip}} VIP{{/if}} user");
    expect(tpl.render({ vip: true })).toBe("Hello VIP user");
  });

  it("omits the conditional body when the variable is falsy", () => {
    const tpl = PromptTemplate.compile("Hello{{#if vip}} VIP{{/if}} user");
    expect(tpl.render({ vip: false })).toBe("Hello user");
  });

  it("treats 0 and empty-string as falsy", () => {
    const tpl = PromptTemplate.compile("[{{#if x}}A{{/if}}]");
    expect(tpl.render({ x: 0 })).toBe("[]");
    expect(tpl.render({ x: "" })).toBe("[]");
  });

  it("treats non-empty string as truthy", () => {
    const tpl = PromptTemplate.compile("[{{#if x}}A{{/if}}]");
    expect(tpl.render({ x: "yes" })).toBe("[A]");
  });

  it("supports nested paths inside conditionals", () => {
    const tpl = PromptTemplate.compile("Hi{{#if user.vip}} VIP{{/if}}");
    expect(tpl.render({ user: { vip: true } })).toBe("Hi VIP");
    expect(tpl.render({ user: { vip: false } })).toBe("Hi");
  });
});

describe("PromptTemplate.render — mixed conditional + interpolation", () => {
  it("interpolates variables inside a conditional body", () => {
    const tpl = PromptTemplate.compile(
      "Hello{{#if vip}} {{name}} (VIP){{/if}}",
    );
    expect(tpl.render({ vip: true, name: "Alice" })).toBe("Hello Alice (VIP)");
    expect(tpl.render({ vip: false, name: "Alice" })).toBe("Hello");
  });

  it("supports adjacent variables and conditionals", () => {
    const tpl = PromptTemplate.compile(
      "{{greeting}}{{name}}{{#if bang}}!{{/if}}",
    );
    expect(tpl.render({ greeting: "Hi ", name: "Alice", bang: true })).toBe(
      "Hi Alice!",
    );
    expect(tpl.render({ greeting: "Hi ", name: "Alice", bang: false })).toBe(
      "Hi Alice",
    );
  });
});

describe("PromptTemplate.render — undefined variable handling", () => {
  it("throws PromptTemplateError for a missing top-level variable", () => {
    const tpl = PromptTemplate.compile("Hello {{missing}}");
    expect(() => tpl.render({})).toThrow(PromptTemplateError);
    expect(() => tpl.render({})).toThrow(/missing/);
  });

  it("the thrown error has name 'PromptTemplateError'", () => {
    const tpl = PromptTemplate.compile("Hello {{missing}}");
    try {
      tpl.render({});
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe("PromptTemplateError");
    }
  });

  it("throws PromptTemplateError for an undefined conditional variable (NOT silent false)", () => {
    const tpl = PromptTemplate.compile("Hello{{#if vip}} VIP{{/if}}");
    expect(() => tpl.render({})).toThrow(PromptTemplateError);
    expect(() => tpl.render({})).toThrow(/vip/);
  });

  it("throws PromptTemplateError when a nested path segment is missing", () => {
    const tpl = PromptTemplate.compile("Hi {{user.name}}");
    expect(() => tpl.render({ user: {} })).toThrow(PromptTemplateError);
    expect(() => tpl.render({ user: {} })).toThrow(/user\.name/);
  });

  it("throws PromptTemplateError when the root of a nested path is missing", () => {
    const tpl = PromptTemplate.compile("Hi {{user.name}}");
    expect(() => tpl.render({})).toThrow(PromptTemplateError);
  });
});

describe("PromptTemplateError", () => {
  it("is an instance of Error", () => {
    const err = new PromptTemplateError("boom");
    expect(err).toBeInstanceOf(Error);
  });

  it("has name 'PromptTemplateError'", () => {
    const err = new PromptTemplateError("boom");
    expect(err.name).toBe("PromptTemplateError");
  });

  it("preserves the message", () => {
    const err = new PromptTemplateError("something went wrong");
    expect(err.message).toBe("something went wrong");
  });
});
