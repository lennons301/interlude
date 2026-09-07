import { describe, it, expect } from "vitest";
import {
  BASIC_CHALLENGE,
  EXEMPT_PATHS,
  OPERATOR_USER,
  decideOperatorAuth,
  isExemptPath,
  parseBasicAuthorization,
  type OperatorAuthInput,
} from "../operator-auth";

/**
 * The operator gate's decision (issue #242): who gets through, and which paths
 * never need to. The exempt set is pinned entry by entry — adding one is a
 * reviewed change to this file, not a side effect.
 */

const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

function decide(over: Partial<OperatorAuthInput>) {
  return decideOperatorAuth({
    pathname: "/api/settings/overrides",
    authorization: null,
    password: "s3cret",
    production: true,
    ...over,
  });
}

describe("exempt paths are exactly the ones that must stay open", () => {
  it("pins the set", () => {
    expect([...EXEMPT_PATHS].sort()).toEqual(
      [
        "/api/webhooks/github", // verifies its own HMAC signature
        "/api/internal/validate-subdomain", // Caddy's on-demand TLS `ask`
        "/manifest.webmanifest", // fetched credential-less by spec; not secret
      ].sort()
    );
  });

  it("matches exactly, tolerating one trailing slash", () => {
    expect(isExemptPath("/api/webhooks/github")).toBe(true);
    expect(isExemptPath("/api/webhooks/github/")).toBe(true);
    expect(isExemptPath("/api/webhooks/github/extra")).toBe(false);
    expect(isExemptPath("/api/webhooks")).toBe(false);
    expect(isExemptPath("/API/webhooks/github")).toBe(false);
  });

  it("gates everything that moves money, creates work, or reads state", () => {
    for (const path of [
      "/",
      "/settings",
      "/tasks/01ABC",
      "/api/settings/overrides",
      "/api/settings/metered-spend",
      "/api/runs/01ABC/lane-move",
      "/api/tasks",
      "/api/projects",
      "/api/fleet/stream",
      "/api/tasks/01ABC/preview/",
      "/_next/static/chunks/main.js",
    ]) {
      expect(isExemptPath(path), path).toBe(false);
      expect(decide({ pathname: path }).kind, path).toBe("unauthorized");
    }
  });

  it("serves an exempt path with no credential at all, even in production", () => {
    for (const path of EXEMPT_PATHS) {
      expect(decide({ pathname: path })).toEqual({ kind: "allow", why: "exempt" });
      expect(decide({ pathname: path, password: null })).toEqual({
        kind: "allow",
        why: "exempt",
      });
    }
  });
});

describe("the credential", () => {
  it("admits the operator with the configured password", () => {
    expect(decide({ authorization: basic(OPERATOR_USER, "s3cret") })).toEqual({
      kind: "allow",
      why: "credential",
    });
  });

  it("refuses a wrong password, a wrong user, and an empty one", () => {
    expect(decide({ authorization: basic(OPERATOR_USER, "s3cret ") }).kind).toBe("unauthorized");
    expect(decide({ authorization: basic(OPERATOR_USER, "S3CRET") }).kind).toBe("unauthorized");
    expect(decide({ authorization: basic("admin", "s3cret") }).kind).toBe("unauthorized");
    expect(decide({ authorization: basic("", "s3cret") }).kind).toBe("unauthorized");
    expect(decide({ authorization: basic(OPERATOR_USER, "") }).kind).toBe("unauthorized");
  });

  it("refuses anything that is not a Basic credential", () => {
    expect(decide({ authorization: null }).kind).toBe("unauthorized");
    expect(decide({ authorization: "Bearer s3cret" }).kind).toBe("unauthorized");
    expect(decide({ authorization: "Basic" }).kind).toBe("unauthorized");
    expect(decide({ authorization: "Basic !!!" }).kind).toBe("unauthorized");
    // Decodes, but carries no colon — not user:password.
    expect(
      decide({ authorization: `Basic ${Buffer.from("s3cret").toString("base64")}` }).kind
    ).toBe("unauthorized");
  });

  it("allows a password containing colons", () => {
    expect(decide({ password: "a:b:c", authorization: basic(OPERATOR_USER, "a:b:c") }).kind).toBe(
      "allow"
    );
    expect(parseBasicAuthorization(basic("operator", "a:b:c"))).toEqual({
      user: "operator",
      password: "a:b:c",
    });
  });

  it("challenges with Basic so a browser prompts once and remembers", () => {
    expect(BASIC_CHALLENGE).toMatch(/^Basic realm="interlude"/);
  });
});

describe("no password configured", () => {
  it("fails closed in production: gated paths are refused as misconfigured, not opened", () => {
    expect(decide({ password: null })).toEqual({ kind: "misconfigured" });
    expect(decide({ password: "" })).toEqual({ kind: "misconfigured" });
    // Even a request carrying some credential — there is nothing to check it against.
    expect(decide({ password: null, authorization: basic(OPERATOR_USER, "x") })).toEqual({
      kind: "misconfigured",
    });
  });

  it("stays open in development so `pnpm dev` works unchanged", () => {
    expect(decide({ password: null, production: false })).toEqual({ kind: "allow", why: "open" });
  });

  it("gates a development instance the moment a password is set, so the gate can be tried locally", () => {
    expect(decide({ production: false }).kind).toBe("unauthorized");
    expect(decide({ production: false, authorization: basic(OPERATOR_USER, "s3cret") }).kind).toBe(
      "allow"
    );
  });
});
