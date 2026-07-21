/**
 * Sandbox worker — runs inside the forked child process.
 *
 * Responsibilities:
 * 1. Listen for `process.on("message")` carrying a `WorkerRequest`.
 * 2. Evaluate the `script` string in a CommonJS-like context
 *    (`module`, `exports`, `require`) using `new Function(...)`.
 * 3. Call the exported function with `input`.
 * 4. Send back a `WorkerResponse` ({ success, output } or { success, error }).
 * 5. Exit cleanly so the parent's `exit` handler is not invoked with a
 *    misleading exit code.
 *
 * The script is plain JS source using the pattern:
 *   `module.exports = async (input) => ({ ... })`
 *
 * NOTE: This file is compiled to `dist/sandbox-worker.mjs` (ESM) by tsup.
 * It uses `createRequire(import.meta.url)` so the script's `require()`
 * shim can load allowed Node built-in modules.
 */

import { createRequire } from "node:module";

interface WorkerRequest {
  toolId: string;
  input: unknown;
  script: string;
}

interface WorkerErrorInfo {
  name: string;
  message: string;
  code?: string;
}

interface WorkerResponse {
  success: boolean;
  output?: unknown;
  error?: WorkerErrorInfo;
}

/**
 * Built-in modules the sandboxed script may `require()`. Anything else is
 * rejected to keep the sandbox hermetic. This is a security boundary, not
 * a fallback — the worker is isolated but we still want to prevent the
 * script from loading arbitrary native modules.
 */
const ALLOWED_MODULES = [
  "node:fs/promises",
  "node:path",
  "node:os",
  "node:crypto",
  "node:url",
] as const;

const nodeRequire = createRequire(import.meta.url);

function makeRequire(): (name: string) => unknown {
  return (name: string): unknown => {
    if (!ALLOWED_MODULES.includes(name as (typeof ALLOWED_MODULES)[number])) {
      throw new Error(`Module not allowed in sandbox: ${name}`);
    }
    return nodeRequire(name);
  };
}

async function handleRequest(req: WorkerRequest): Promise<WorkerResponse> {
  // Evaluate the script in a CommonJS-like context.
  // The script is expected to do `module.exports = async (input) => ...`.
  const moduleObj = { exports: undefined as unknown };

  try {
    const fn = new Function("module", "exports", "require", req.script);
    fn(moduleObj, moduleObj.exports, makeRequire());
  } catch (err) {
    const e = err as Error;
    // SyntaxError, ReferenceError, etc. — script never produced an export.
    return {
      success: false,
      error: { name: e.name, message: e.message },
    };
  }

  const execute = moduleObj.exports;
  if (typeof execute !== "function") {
    return {
      success: false,
      error: {
        name: "SandboxError",
        message: "Script did not export a function",
        code: "INVALID_SCRIPT",
      },
    };
  }

  try {
    const output = await (execute as (input: unknown) => Promise<unknown>)(
      req.input,
    );
    return { success: true, output };
  } catch (err) {
    const e = err as Error;
    // The script's execute function threw — treat as a tool crash so
    // callers can distinguish script-logic failures from sandbox failures.
    return {
      success: false,
      error: {
        name: "ToolCrashError",
        message: e.message,
        code: "TOOL_CRASH",
      },
    };
  }
}

const send = process.send?.bind(process);
if (typeof send !== "function") {
  // Worker was started without an IPC channel (i.e. not via child_process.fork).
  // Fail fast rather than hanging.
  process.exit(1);
}

process.on("message", async (msg: WorkerRequest) => {
  const response = await handleRequest(msg);
  send(response);
  process.exit(0);
});
