import { z } from "zod";
import type { ToolContext } from "../context.js";
import { createTool } from "../definition.js";
import type {
  PermissionCheckResult,
  SafetyGuard,
  ToolSpecificRule,
} from "../permission/types.js";

const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MB
const DEFAULT_TIMEOUT_MS = 30_000;

const DEFAULT_ALLOWED_DOMAINS: ReadonlySet<string> = new Set([
  "api.github.com",
  "registry.npmjs.org",
  "pypi.org",
]);

// SSRF protection — hostnames that must always be refused.
const BLOCKED_HOSTNAMES: ReadonlyArray<string> = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
  "169.254.169.254", // cloud metadata endpoint
];

// Private / link-local IP ranges matched against the hostname literal.
const PRIVATE_IP_PATTERNS: ReadonlyArray<RegExp> = [
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, // 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/, // 172.16.0.0/12
  /^192\.168\.\d{1,3}\.\d{1,3}$/, // 192.168.0.0/16
  /^169\.254\.\d{1,3}\.\d{1,3}$/, // 169.254.0.0/16 link-local
];

/**
 * SSRF protection check. Returns a reason string describing why the URL is
 * blocked, or `null` if the URL is acceptable. Pure function — safe to unit
 * test without making any network calls.
 */
export function checkSsrf(urlString: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return `Invalid URL: ${urlString}`;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `SSRF blocked: protocol "${parsed.protocol}" is not allowed (only http/https)`;
  }

  const hostname = parsed.hostname.toLowerCase();

  for (const blocked of BLOCKED_HOSTNAMES) {
    if (hostname === blocked) {
      return `SSRF blocked: hostname "${hostname}" is not allowed`;
    }
  }

  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(hostname)) {
      return `SSRF blocked: private IP range "${hostname}" is not allowed`;
    }
  }

  return null;
}

/**
 * Structured SSRF check result — alternative shape for callers that prefer
 * a boolean field plus optional reason. Wraps {@link checkSsrf} so the
 * canonical implementation stays in one place.
 */
export interface SsrfCheckResult {
  safe: boolean;
  reason?: string;
}

/**
 * SSRF protection check returning a structured result. Equivalent to
 * {@link checkSsrf} but returns `{ safe: true }` or
 * `{ safe: false, reason: "..." }` — convenient for direct use as a
 * safety-guards predicate and for callers that want a boolean.
 */
export function isSsrfSafe(url: string): SsrfCheckResult {
  const reason = checkSsrf(url);
  if (reason === null) return { safe: true };
  return { safe: false, reason };
}

const httpInputSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]),
  url: z
    .string()
    .url()
    .describe(
      "Absolute http(s) URL to request. Private IPs and localhost are blocked.",
    ),
  headers: z.record(z.string()).optional(),
  body: z
    .string()
    .optional()
    .describe("Raw request body (use JSON.stringify if you need JSON)."),
  timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
  maxBytes: z.number().int().positive().default(DEFAULT_MAX_BYTES),
});

const httpOutputSchema = z.object({
  status: z.number(),
  statusText: z.string(),
  headers: z.record(z.string()),
  body: z.string(),
  bytes: z.number(),
  durationMs: z.number(),
  truncated: z.boolean(),
});

export type HttpRequestInput = z.infer<typeof httpInputSchema>;
export type HttpRequestOutput = z.infer<typeof httpOutputSchema>;

/**
 * `http.request` — perform an HTTP request using the Node 20 built-in fetch.
 * The body is streamed with a hard `maxBytes` cap; the raw body is returned as
 * a UTF-8 string (the LLM is free to JSON.parse it if it wants).
 *
 * The tool does NOT follow redirects automatically and does NOT carry a cookie
 * jar — those decisions are left to the caller.
 */
export const httpRequestTool = createTool({
  id: "http.request",
  description:
    "Make an HTTP request and return the response (status, headers, body). SSRF protection blocks private IPs, localhost, and cloud metadata endpoints. The response body is truncated at maxBytes; redirects are not followed.",
  inputSchema: httpInputSchema,
  outputSchema: httpOutputSchema,
  permission: { toolId: "http.request", decision: "ask" },
  tags: ["network", "http"],
  execute: async (input, _ctx) => {
    // SSRF check — never bypassable. AGENTS.md forbids fallback strategies,
    // so we throw rather than return a synthetic error response.
    const ssrfError = checkSsrf(input.url);
    if (ssrfError) {
      throw new Error(ssrfError);
    }

    // After the definition.ts fix (inputSchema: z.ZodType<I, any, any>),
    // `input` is typed as the OUTPUT type (post-parse), where `.default()`
    // fields are required. No non-null assertions needed.
    const timeoutMs = input.timeoutMs;
    const maxBytes = input.maxBytes;

    const startTime = Date.now();
    const ac = new AbortController();
    const timeoutHandle = setTimeout(() => ac.abort(), timeoutMs);

    try {
      const response = await fetch(input.url, {
        method: input.method,
        headers: input.headers,
        body: input.body,
        signal: ac.signal,
        redirect: "manual",
      });

      // Stream the body with a hard size cap. We deliberately do not parse
      // JSON here — the LLM caller decides how to interpret the bytes.
      const reader = response.body?.getReader();
      let bodyBuf = new Uint8Array(0);
      let truncated = false;

      if (reader) {
        // Loop until either the stream ends or we hit maxBytes.
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value === undefined) continue;

          const nextLen = bodyBuf.length + value.length;
          if (nextLen <= maxBytes) {
            const merged = new Uint8Array(nextLen);
            merged.set(bodyBuf, 0);
            merged.set(value, bodyBuf.length);
            bodyBuf = merged;
            continue;
          }

          // We would overflow — copy only what fits, then stop.
          const remaining = maxBytes - bodyBuf.length;
          if (remaining > 0) {
            const merged = new Uint8Array(maxBytes);
            merged.set(bodyBuf, 0);
            merged.set(value.subarray(0, remaining), bodyBuf.length);
            bodyBuf = merged;
          }
          truncated = true;
          break;
        }
        try {
          await reader.cancel();
        } catch {
          // Reader may already be closed; safe to ignore.
        }
      }

      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      return {
        status: response.status,
        statusText: response.statusText,
        headers,
        body: new TextDecoder("utf-8").decode(bodyBuf),
        bytes: bodyBuf.byteLength,
        durationMs: Date.now() - startTime,
        truncated,
      };
    } catch (err) {
      // Surface a clear "timed out" message when the AbortController fires.
      // The native AbortError name is "AbortError" in undici/Node 20 fetch.
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`HTTP request timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutHandle);
    }
  },
});

/**
 * Safety guard (layer 5) — runs before any allow rule and cannot be bypassed
 * by `auto-approve-all` mode or persisted allow rules. If the URL is on the
 * SSRF blocklist, the request is refused outright.
 */
export const httpSsrfGuard: SafetyGuard = {
  name: "http-ssrf-guard",
  evaluate: (tool, input, _ctx) => {
    if (tool.id !== "http.request") return null;
    if (typeof input !== "object" || input === null) return null;
    const { url } = input as { url?: unknown };
    if (typeof url !== "string") return null;
    const blocked = checkSsrf(url);
    if (blocked) {
      return { allowed: false, reason: blocked };
    }
    return null; // URL is OK — fall through to other layers.
  },
};

/**
 * Tool-specific rule (layer 4) — auto-allow well-known public registries that
 * the tool ships with by default. Anything else falls through to `ask`.
 */
export const httpDomainRule: ToolSpecificRule = {
  toolId: "http.request",
  evaluate: (input, _ctx): PermissionCheckResult | null => {
    if (typeof input !== "object" || input === null) return null;
    const { url } = input as { url?: unknown };
    if (typeof url !== "string") return null;
    try {
      const parsed = new URL(url);
      if (DEFAULT_ALLOWED_DOMAINS.has(parsed.hostname.toLowerCase())) {
        return {
          allowed: true,
          reason: `Domain ${parsed.hostname} is on the default whitelist`,
        };
      }
    } catch {
      // Invalid URL — let the SSRF guard produce the diagnostic.
    }
    return null; // Not whitelisted — fall through to ask.
  },
};

export { DEFAULT_ALLOWED_DOMAINS };
