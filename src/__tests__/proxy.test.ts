import { describe, it, expect, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../proxy";

/**
 * `src/proxy.ts` turns the operator-gate decision (issue #242) into responses.
 * The decision table lives in operator-auth.test.ts; this checks the wiring —
 * status codes, the Basic challenge, and that the environment is read the way
 * the runbook says.
 */

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

function request(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`https://interludes.co.uk${path}`, { headers });
}

const basic = (password: string) =>
  `Basic ${Buffer.from(`operator:${password}`).toString("base64")}`;

describe("proxy — the operator gate", () => {
  it("challenges an unauthenticated request for a gated route", () => {
    process.env.OPERATOR_PASSWORD = "pw";
    const res = proxy(request("/api/settings/overrides"));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Basic realm="interlude"/);
  });

  it("passes the operator through", () => {
    process.env.OPERATOR_PASSWORD = "pw";
    const res = proxy(request("/api/settings/overrides", { authorization: basic("pw") }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("serves the GitHub webhook and Caddy's validator without a credential", () => {
    process.env.OPERATOR_PASSWORD = "pw";
    expect(proxy(request("/api/webhooks/github")).status).toBe(200);
    expect(proxy(request("/api/internal/validate-subdomain?domain=x")).status).toBe(200);
  });

  it("refuses with 503 when a production build has no password to check", () => {
    delete process.env.OPERATOR_PASSWORD;
    // NODE_ENV is read-only under some bundlers; vitest lets a test set it.
    (process.env as Record<string, string>).NODE_ENV = "production";
    const res = proxy(request("/"));
    expect(res.status).toBe(503);
  });
});
