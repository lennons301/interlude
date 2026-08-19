import { describe, it, expect, afterEach, vi } from "vitest";
import { createOctokit, isTokenFresh } from "../client";

describe("isTokenFresh", () => {
  const now = 1_000_000_000_000;

  it("is fresh when expiry is well in the future", () => {
    expect(isTokenFresh(now + 30 * 60 * 1000, now)).toBe(true);
  });

  it("is stale within the 5-minute safety margin", () => {
    expect(isTokenFresh(now + 4 * 60 * 1000, now)).toBe(false);
  });

  it("is stale when already expired", () => {
    expect(isTokenFresh(now - 1000, now)).toBe(false);
  });

  it("treats a zero/unset expiry as stale", () => {
    expect(isTokenFresh(0, now)).toBe(false);
  });
});

/**
 * Every client this module hands out is bounded (issue #151). The App's own
 * client, the installation client and the reviewer's client are all built by
 * this one factory; a lint rule (eslint.config.mjs) keeps it the only place a
 * client can be built, so the bound cannot be forgotten at a call site.
 */
describe("createOctokit", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fails a request that never answers instead of hanging on it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {}))
    );

    const octokit = createOctokit("installation-token", 20);

    await expect(
      // Octokit re-issues a timed-out request by default; this asks for the one
      // attempt, so the assertion is about the bound rather than the backoff.
      octokit.request("GET /rate_limit", { request: { retries: 0 } })
    ).rejects.toThrow(/timed out after 20ms/);
  });
});
