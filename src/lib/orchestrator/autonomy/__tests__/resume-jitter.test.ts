import { describe, expect, it } from "vitest";
import { resumeEligibleAt, resumeJitterMs } from "../resume-jitter";

/**
 * The stampede guard (issue #169). Every run the fleet paused was refused by
 * the same account-wide window and carries the same reset time, so what these
 * check is that the offset is (a) inside the window, (b) *stable* for a run,
 * and (c) different between runs — the three properties the reducer leans on.
 */

const WINDOW = 5 * 60_000;

describe("a run's offset into the resume window", () => {
  it("stays inside the window", () => {
    for (let i = 0; i < 500; i++) {
      const offset = resumeJitterMs(`01K${i}ZZZRUNID`, WINDOW);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(WINDOW);
    }
  });

  it("is the same every time it is asked", () => {
    // The reducer is pure and runs every 30 seconds: an offset that moved
    // between sweeps would make a run eligible at 12:01 and not at 12:02.
    expect(resumeJitterMs("run-1", WINDOW)).toBe(resumeJitterMs("run-1", WINDOW));
  });

  it("spreads runs across the window rather than clustering them", () => {
    const ids = Array.from({ length: 200 }, (_, i) => `01KZC1D0${i}`);
    const buckets = new Set(
      ids.map((id) => Math.floor(resumeJitterMs(id, WINDOW) / 30_000))
    );

    // Ten 30-second buckets in a five-minute window; a hash that bunched every
    // run into one of them would guard nothing.
    expect(buckets.size).toBeGreaterThan(5);
  });

  it("has no jitter at all when the window is zero", () => {
    expect(resumeJitterMs("run-1", 0)).toBe(0);
    expect(resumeJitterMs("run-1", -1)).toBe(0);
    expect(resumeJitterMs("run-1", Number.NaN)).toBe(0);
  });
});

describe("when a paused run may be tried again", () => {
  it("is its window's reset plus its own offset", () => {
    const resetAt = new Date("2026-09-02T17:00:00.000Z");

    expect(resumeEligibleAt("run-1", resetAt, WINDOW).getTime()).toBe(
      resetAt.getTime() + resumeJitterMs("run-1", WINDOW)
    );
  });

  it("is the reset itself when jitter is switched off", () => {
    const resetAt = new Date("2026-09-02T17:00:00.000Z");

    expect(resumeEligibleAt("run-1", resetAt, 0)).toEqual(resetAt);
  });
});
