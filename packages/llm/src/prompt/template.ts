import { PromptTemplateError } from "./errors.js";

type TextNode = { readonly type: "text"; readonly text: string };
type VarNode = { readonly type: "var"; readonly path: string };
type IfNode = {
  readonly type: "if";
  readonly path: string;
  readonly body: ReadonlyArray<TemplateNode>;
};
type TemplateNode = TextNode | VarNode | IfNode;

interface ParseContext {
  src: string;
  pos: number;
}

export class PromptTemplate {
  readonly #nodes: ReadonlyArray<TemplateNode>;

  private constructor(nodes: ReadonlyArray<TemplateNode>) {
    this.#nodes = nodes;
  }

  static compile(template: string): PromptTemplate {
    const ctx: ParseContext = { src: template, pos: 0 };
    const nodes = parseNodes(ctx, false);
    if (ctx.pos < ctx.src.length) {
      throw new PromptTemplateError(
        `Unexpected content at position ${ctx.pos}: ${ctx.src.slice(ctx.pos, ctx.pos + 16)}`,
      );
    }
    return new PromptTemplate(nodes);
  }

  render(vars: Record<string, unknown>): string {
    return renderNodes(this.#nodes, vars);
  }
}

function parseNodes(ctx: ParseContext, inConditional: boolean): TemplateNode[] {
  const nodes: TemplateNode[] = [];
  while (ctx.pos < ctx.src.length) {
    if (ctx.src.startsWith("{{", ctx.pos)) {
      const closeIdx = ctx.src.indexOf("}}", ctx.pos + 2);
      if (closeIdx === -1) {
        throw new PromptTemplateError(`Unclosed '{{' at position ${ctx.pos}`);
      }
      const inside = ctx.src.slice(ctx.pos + 2, closeIdx).trim();
      if (inside === "/if") {
        if (!inConditional) {
          throw new PromptTemplateError(
            `Unexpected '{{/if}}' at position ${ctx.pos}`,
          );
        }
        ctx.pos = closeIdx + 2;
        return nodes;
      }
      if (inside.startsWith("#if ")) {
        const condPath = inside.slice(4).trim();
        if (condPath === "") {
          throw new PromptTemplateError(
            `Empty conditional expression at position ${ctx.pos}`,
          );
        }
        ctx.pos = closeIdx + 2;
        const body = parseNodes(ctx, true);
        nodes.push({ type: "if", path: condPath, body });
        continue;
      }
      if (inside === "") {
        throw new PromptTemplateError(
          `Empty variable expression at position ${ctx.pos}`,
        );
      }
      nodes.push({ type: "var", path: inside });
      ctx.pos = closeIdx + 2;
      continue;
    }
    const nextOpen = ctx.src.indexOf("{{", ctx.pos);
    const end = nextOpen === -1 ? ctx.src.length : nextOpen;
    nodes.push({ type: "text", text: ctx.src.slice(ctx.pos, end) });
    ctx.pos = end;
  }
  if (inConditional) {
    throw new PromptTemplateError("Unclosed '{{#if}}' block");
  }
  return nodes;
}

function resolvePath(vars: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = vars;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object") {
      throw new PromptTemplateError(`Undefined variable: ${path}`);
    }
    const next = (cur as Record<string, unknown>)[part];
    if (next === undefined) {
      throw new PromptTemplateError(`Undefined variable: ${path}`);
    }
    cur = next;
  }
  return cur;
}

function renderNodes(
  nodes: ReadonlyArray<TemplateNode>,
  vars: Record<string, unknown>,
): string {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out += node.text;
        break;
      case "var": {
        const value = resolvePath(vars, node.path);
        out += String(value);
        break;
      }
      case "if": {
        const value = resolvePath(vars, node.path);
        if (value) {
          out += renderNodes(node.body, vars);
        }
        break;
      }
    }
  }
  return out;
}
