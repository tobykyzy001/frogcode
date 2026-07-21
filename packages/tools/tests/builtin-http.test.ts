import { describe, it, expect } from "vitest";
import type { ToolContext } from "../src/context.js";
import {
  checkSsrf,
  httpRequestTool,
  httpSsrfGuard,
  httpDomainRule,
  isSsrfSafe,
  DEFAULT_ALLOWED_DOMAINS,
} from "../src/index.js";

const ctx = {} as ToolContext;

/**
 * Helper to invoke the tool's execute() with the SSRF check happening first.
 * Defaults mirror the zod schema defaults so callers can omit them.
 */
async function runHttp(input: Record<string, unknown>) {
  return httpRequestTool.execute(input as never, ctx);
}

describe("checkSsrf — pure function", () => {
  it("blocks localhost", () => {
    const reason = checkSsrf("http://localhost:8080");
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/SSRF blocked/);
    expect(reason).toContain("localhost");
  });

  it("blocks 127.0.0.1", () => {
    const reason = checkSsrf("http://127.0.0.1/");
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/SSRF blocked/);
  });

  it("blocks the cloud metadata endpoint 169.254.169.254", () => {
    const reason = checkSsrf("http://169.254.169.254/latest/meta-data/");
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/SSRF blocked/);
  });

  it("blocks private IP 10.x", () => {
    const reason = checkSsrf("http://10.0.0.1/");
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/private IP range/);
  });

  it("blocks private IP 192.168.x", () => {
    const reason = checkSsrf("http://192.168.1.1/");
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/private IP range/);
  });

  it("blocks private IP 172.16.x", () => {
    const reason = checkSsrf("http://172.16.5.5/");
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/private IP range/);
  });

  it("allows a public domain", () => {
    const reason = checkSsrf("https://example.com/");
    expect(reason).toBeNull();
  });

  it("allows a whitelisted public domain", () => {
    expect(checkSsrf("https://api.github.com/users/octocat")).toBeNull();
    expect(checkSsrf("https://registry.npmjs.org/lodash")).toBeNull();
    expect(checkSsrf("https://pypi.org/project/requests/")).toBeNull();
  });

  it("blocks non-http(s) protocols (file://)", () => {
    const reason = checkSsrf("file:///etc/passwd");
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/SSRF blocked/);
    expect(reason).toMatch(/protocol/);
  });

  it("blocks non-http(s) protocols (ftp://)", () => {
    const reason = checkSsrf("ftp://example.com/file");
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/protocol/);
  });

  it("returns an error for an invalid URL", () => {
    const reason = checkSsrf("not-a-url");
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/Invalid URL/);
  });
});

describe("httpRequestTool — SSRF enforcement in execute()", () => {
  it("throws on localhost URL before any network call", async () => {
    await expect(
      runHttp({ method: "GET", url: "http://localhost:8080" }),
    ).rejects.toThrow(/SSRF/);
  });

  it("throws on private IP URL before any network call", async () => {
    await expect(
      runHttp({ method: "GET", url: "http://10.0.0.5/admin" }),
    ).rejects.toThrow(/SSRF/);
  });

  it("throws on metadata endpoint", async () => {
    await expect(
      runHttp({ method: "GET", url: "http://169.254.169.254/latest/meta-data/" }),
    ).rejects.toThrow(/SSRF/);
  });

  it("throws on non-http protocol", async () => {
    await expect(
      runHttp({ method: "GET", url: "file:///etc/passwd" }),
    ).rejects.toThrow(/SSRF/);
  });
});

describe("httpSsrfGuard — safety guard layer", () => {
  it("blocks localhost URLs with allowed=false", () => {
    const result = httpSsrfGuard.evaluate(
      httpRequestTool,
      { url: "http://localhost:8080" },
      ctx,
    );
    expect(result).not.toBeNull();
    expect(result?.allowed).toBe(false);
    expect(result?.reason).toMatch(/SSRF/);
  });

  it("returns null (no opinion) for whitelisted public domain", () => {
    const result = httpSsrfGuard.evaluate(
      httpRequestTool,
      { url: "https://api.github.com/users/octocat" },
      ctx,
    );
    expect(result).toBeNull();
  });

  it("returns null for non-http.request tools", () => {
    const otherTool = { ...httpRequestTool, id: "other.tool" } as never;
    const result = httpSsrfGuard.evaluate(
      otherTool,
      { url: "http://localhost/" },
      ctx,
    );
    expect(result).toBeNull();
  });

  it("returns null when input has no url field", () => {
    const result = httpSsrfGuard.evaluate(httpRequestTool, {}, ctx);
    expect(result).toBeNull();
  });
});

describe("httpDomainRule — tool-specific permission rule", () => {
  it("auto-allows whitelisted domain api.github.com", () => {
    const result = httpDomainRule.evaluate(
      { url: "https://api.github.com/users/octocat" },
      ctx,
    );
    expect(result).toEqual({ allowed: true, reason: expect.stringMatching(/api\.github\.com/) });
  });

  it("auto-allows whitelisted domain registry.npmjs.org", () => {
    const result = httpDomainRule.evaluate(
      { url: "https://registry.npmjs.org/lodash" },
      ctx,
    );
    expect(result?.allowed).toBe(true);
  });

  it("auto-allows whitelisted domain pypi.org", () => {
    const result = httpDomainRule.evaluate(
      { url: "https://pypi.org/project/requests/" },
      ctx,
    );
    expect(result?.allowed).toBe(true);
  });

  it("returns null for non-whitelisted public domain (falls through to ask)", () => {
    const result = httpDomainRule.evaluate(
      { url: "https://example.com/" },
      ctx,
    );
    expect(result).toBeNull();
  });

  it("returns null for SSRF-blocked URLs (let the safety guard decide)", () => {
    const result = httpDomainRule.evaluate(
      { url: "http://localhost/" },
      ctx,
    );
    expect(result).toBeNull();
  });

  it("returns null when input has no url field", () => {
    const result = httpDomainRule.evaluate({}, ctx);
    expect(result).toBeNull();
  });
});

describe("DEFAULT_ALLOWED_DOMAINS", () => {
  it("contains the three default public registries", () => {
    expect(DEFAULT_ALLOWED_DOMAINS.has("api.github.com")).toBe(true);
    expect(DEFAULT_ALLOWED_DOMAINS.has("registry.npmjs.org")).toBe(true);
    expect(DEFAULT_ALLOWED_DOMAINS.has("pypi.org")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Network-dependent tests — skipped by default to keep CI hermetic.
// They are useful for manual verification with `pnpm test -- --testNamePattern=httpbin`.
// To enable locally, set FROGCODE_NETWORK_TESTS=1 in your environment.
// ---------------------------------------------------------------------------
const NETWORK_TESTS_ENABLED = process.env.FROGCODE_NETWORK_TESTS === "1";
const networkIt = NETWORK_TESTS_ENABLED ? it : it.skip;

describe("httpRequestTool — live network (skipped unless FROGCODE_NETWORK_TESTS=1)", () => {
  networkIt("GETs https://httpbin.org/get and returns 200 with body", async () => {
    const result = await runHttp({
      method: "GET",
      url: "https://httpbin.org/get",
      timeoutMs: 15_000,
    });
    expect(result.status).toBe(200);
    expect(result.body).toContain("httpbin.org");
    expect(result.truncated).toBe(false);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.bytes).toBeGreaterThan(0);
  });

  networkIt("aborts with timeout when server is too slow", async () => {
    // httpbin delays 10s; we abort at 1s. This must reject, not silently return.
    await expect(
      runHttp({
        method: "GET",
        url: "https://httpbin.org/delay/10",
        timeoutMs: 1000,
      }),
    ).rejects.toThrow();
  });

  networkIt("surfaces 404 status without throwing", async () => {
    const result = await runHttp({
      method: "GET",
      url: "https://httpbin.org/status/404",
      timeoutMs: 15_000,
    });
    expect(result.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// isSsrfSafe — structured { safe, reason? } API (Task 11 spec).
// These tests mirror checkSsrf's coverage but exercise the boolean-shaped
// wrapper that downstream safety-guards callers are expected to consume.
// ---------------------------------------------------------------------------

describe("isSsrfSafe — structured API", () => {
  it("rejects localhost (safe === false)", () => {
    const r = isSsrfSafe("http://localhost:8080");
    expect(r.safe).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it("rejects 127.0.0.1 (safe === false)", () => {
    expect(isSsrfSafe("http://127.0.0.1/").safe).toBe(false);
  });

  it("rejects 0.0.0.0 (safe === false)", () => {
    expect(isSsrfSafe("http://0.0.0.0/").safe).toBe(false);
  });

  it("rejects 169.254.169.254 metadata endpoint (safe === false)", () => {
    const r = isSsrfSafe("http://169.254.169.254/latest/meta-data/");
    expect(r.safe).toBe(false);
    expect(r.reason).toContain("169.254.169.254");
  });

  it("rejects 10.x.x.x private IP (10.0.0.0/8)", () => {
    expect(isSsrfSafe("http://10.0.0.1/").safe).toBe(false);
    expect(isSsrfSafe("http://10.255.255.255/").safe).toBe(false);
  });

  it("rejects 192.168.x.x private IP (192.168.0.0/16)", () => {
    expect(isSsrfSafe("http://192.168.0.1/").safe).toBe(false);
    expect(isSsrfSafe("http://192.168.1.100:3000/").safe).toBe(false);
  });

  it("rejects 172.16-31.x.x private IP (172.16.0.0/12)", () => {
    expect(isSsrfSafe("http://172.16.0.1/").safe).toBe(false);
    expect(isSsrfSafe("http://172.31.255.255/").safe).toBe(false);
  });

  it("allows 172.32.x.x (NOT private — outside 172.16/12 range)", () => {
    expect(isSsrfSafe("http://172.32.0.1/").safe).toBe(true);
    expect(isSsrfSafe("http://172.15.0.1/").safe).toBe(true);
  });

  it("allows public domains (safe === true, no reason)", () => {
    const r1 = isSsrfSafe("https://example.com");
    expect(r1.safe).toBe(true);
    expect(r1.reason).toBeUndefined();
    expect(isSsrfSafe("https://api.github.com").safe).toBe(true);
  });

  it("rejects invalid URL (safe === false)", () => {
    const r = isSsrfSafe("not a url");
    expect(r.safe).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it("rejects non-http(s) protocols (safe === false)", () => {
    expect(isSsrfSafe("file:///etc/passwd").safe).toBe(false);
    expect(isSsrfSafe("ftp://example.com/file").safe).toBe(false);
  });

  it("returns consistent results with checkSsrf for blocked URLs", () => {
    const urls = [
      "http://localhost/",
      "http://10.0.0.1/",
      "http://192.168.1.1/",
      "http://169.254.169.254/",
    ];
    for (const url of urls) {
      const reason = checkSsrf(url);
      const structured = isSsrfSafe(url);
      expect(reason).not.toBeNull();
      expect(structured.safe).toBe(false);
      expect(structured.reason).toBe(reason);
    }
  });
});
