import { describe, it, expect } from "vitest";
import { isTokenFresh } from "../client";

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
