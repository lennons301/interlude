/**
 * The operator gate on the orchestrator's HTTP surface (issue #242).
 *
 * Every page and API route on the deployed orchestrator used to answer to
 * anyone who could reach the host (`auth: none` was the product's declared
 * choice, and Caddy fronts the routes without a gate). On 2026-09-06 a *local*
 * ticket-loop pass changed **production's** execution lane through the same
 * public `PATCH /api/settings/overrides` the settings screen uses, and the
 * owner's own tickets ran on a paid lane until it was put back by hand. Every
 * money guard — the metered cap, the confirm-once press, the lane move — was
 * operated through that same open surface, and `GET /api/projects` served each
 * project's Doppler token in cleartext.
 *
 * This module is the decision; `src/proxy.ts` applies it to every request
 * before it reaches a page or route handler. One mechanism, HTTP Basic, one
 * credential: the fixed user `operator` and the password in
 * `OPERATOR_PASSWORD` (Doppler `interlude/prd`). Basic because the browser
 * does the rest — one prompt on the first page, then every same-origin fetch
 * and EventSource carries it — and because `curl -u` is all a script needs.
 *
 * Fail-closed in production: a production build with no `OPERATOR_PASSWORD`
 * refuses every gated request with 503 rather than quietly opening the
 * surface a misconfigured Doppler var would otherwise expose. Open in
 * development when the variable is unset, so `pnpm dev` works unchanged — and
 * that asymmetry is also the property the ticket asks for: a local process has
 * no credential for production, so it cannot reach it by accident.
 *
 * The exempt list is exactly what has to stay reachable by something that is
 * not the operator's browser, and `operator-auth.test.ts` pins it entry by
 * entry so a new exemption is a deliberate, reviewed change:
 *   - the GitHub webhook, which verifies its own HMAC signature;
 *   - Caddy's on-demand-TLS `ask` endpoint, called host-to-host for every new
 *     preview-subdomain certificate;
 *   - the PWA manifest, which browsers fetch without credentials by spec and
 *     which contains nothing but the app's name and icon paths.
 * Preview subdomains (`task-*.DOMAIN`) never reach Next at all —
 * `custom-server.js` routes them by Host header to the agent container — so
 * they need no entry here and stay reachable exactly as before.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/** Paths served without the operator credential. Exact matches, after a single
 * trailing slash is dropped. Order is irrelevant; the test pins the set. */
export const EXEMPT_PATHS: readonly string[] = [
  "/api/webhooks/github",
  "/api/internal/validate-subdomain",
  "/manifest.webmanifest",
];

/** The one username the gate accepts. Fixed so the credential is one secret,
 * not two. */
export const OPERATOR_USER = "operator";

export type OperatorAuthDecision =
  /** Serve the request. `why` says whether the path is exempt, the gate is
   * open (development, no password configured), or the credential matched. */
  | { kind: "allow"; why: "exempt" | "open" | "credential" }
  /** Refuse with 401 and a Basic challenge. */
  | { kind: "unauthorized" }
  /** Refuse with 503: production, and no password to check against. */
  | { kind: "misconfigured" };

export interface OperatorAuthInput {
  pathname: string;
  /** The request's `Authorization` header, or null. */
  authorization: string | null;
  /** `OPERATOR_PASSWORD` as configured, or null when unset/empty. */
  password: string | null;
  /** Whether this is a production build (`NODE_ENV === "production"`). */
  production: boolean;
}

export function isExemptPath(pathname: string): boolean {
  return EXEMPT_PATHS.includes(normalizePath(pathname));
}

export function decideOperatorAuth(input: OperatorAuthInput): OperatorAuthDecision {
  if (isExemptPath(input.pathname)) return { kind: "allow", why: "exempt" };

  const password = input.password && input.password.length > 0 ? input.password : null;
  if (password == null) {
    return input.production ? { kind: "misconfigured" } : { kind: "allow", why: "open" };
  }

  const presented = parseBasicAuthorization(input.authorization);
  if (!presented) return { kind: "unauthorized" };
  // Compare both halves in constant time and combine the results — never
  // short-circuit on the username, so a probe learns nothing from timing.
  const userOk = constantTimeEqual(presented.user, OPERATOR_USER);
  const passOk = constantTimeEqual(presented.password, password);
  return userOk && passOk ? { kind: "allow", why: "credential" } : { kind: "unauthorized" };
}

/** The challenge a 401 carries so a browser prompts once and remembers. */
export const BASIC_CHALLENGE = 'Basic realm="interlude", charset="UTF-8"';

/** `Authorization: Basic base64(user:password)` → its two halves, or null for
 * anything else (absent, another scheme, undecodable, no colon). */
export function parseBasicAuthorization(
  header: string | null
): { user: string; password: string } | null {
  if (!header) return null;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
  if (!match) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon < 0) return null;
  return { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

function normalizePath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

/** Equality that takes the same time whatever differs — including in length.
 * Both sides are hashed first so the compare is always over two 32-byte
 * digests: a plain byte-wise loop bounded by the longer input would leak the
 * password's length to a probe. `proxy.ts` runs on the Node runtime (Next 16),
 * so `node:crypto` is available here. */
function constantTimeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(a), digest(b));
}
