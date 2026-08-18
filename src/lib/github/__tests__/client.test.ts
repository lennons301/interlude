import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
 * one factory, so the bound cannot be forgotten at a call site — and the last
 * test here is what keeps that true.
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

  it("is the only place a client is constructed", () => {
    const constructions = execFileSync(
      "git",
      ["grep", "-l", "new Octokit(", "--", "src", ":!src/**/__tests__/**"],
      { cwd: process.cwd(), encoding: "utf8" }
    )
      .split("\n")
      .filter(Boolean);
    const client = readFileSync(
      path.join(process.cwd(), "src/lib/github/client.ts"),
      "utf8"
    );

    expect(constructions).toEqual(["src/lib/github/client.ts"]);
    expect(client.match(/new Octokit\(/g)).toHaveLength(1);
  });
});
