import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The sweep nudge (issue #163): the one piece of sweep state a route handler
 * and the orchestrator's loop both touch, so the one that must be shared
 * across module graphs — and the pure tick decision that turns it into at most
 * one sweep at a time.
 */

type Nudge = typeof import("../sweep-nudge");

/** A fresh module graph, as Next gives the app-router alongside the
 * orchestrator's (see cross-graph-state.test.ts for why this is the seam). */
async function loadInSeparateGraph(): Promise<Nudge> {
  vi.resetModules();
  return import("../sweep-nudge");
}

describe("sweep nudge across module graphs", () => {
  beforeEach(async () => {
    // Drain anything a previous test left on globalThis.
    (await loadInSeparateGraph()).takeSweepNudge();
  });

  it("a nudge recorded on the route graph is seen by the orchestrator graph", async () => {
    const routeGraph = await loadInSeparateGraph();
    const orchestratorGraph = await loadInSeparateGraph();
    expect(routeGraph).not.toBe(orchestratorGraph);

    expect(orchestratorGraph.isSweepRequested()).toBe(false);
    routeGraph.requestAutonomySweep("issues.labeled ready-for-agent owner/repo#7");
    expect(orchestratorGraph.isSweepRequested()).toBe(true);

    const taken = orchestratorGraph.takeSweepNudge();
    expect(taken?.reasons).toEqual(["issues.labeled ready-for-agent owner/repo#7"]);
    // Consumed on one graph, gone on the other — there is one slot.
    expect(routeGraph.isSweepRequested()).toBe(false);
    expect(routeGraph.takeSweepNudge()).toBeNull();
  });

  it("a burst of webhooks is one nudge with its reasons deduplicated", async () => {
    const m = await loadInSeparateGraph();
    m.requestAutonomySweep("a");
    m.requestAutonomySweep("b");
    m.requestAutonomySweep("a");
    expect(m.takeSweepNudge(1_000)?.reasons).toEqual(["a", "b"]);
  });

  it("reports how long the nudge waited to be taken", async () => {
    const m = await loadInSeparateGraph();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(10_000));
      m.requestAutonomySweep("x");
      expect(m.takeSweepNudge(10_750)?.waitedMs).toBe(750);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("shouldSweepNow — the loop's tick decision", () => {
  const base = { nowMs: 100_000, intervalMs: 30_000 };

  it("runs the interval sweep when it is due and nothing is in flight", async () => {
    const { shouldSweepNow } = await loadInSeparateGraph();
    expect(
      shouldSweepNow({ ...base, lastSweepStartedAtMs: 70_000, sweeping: false, nudged: false })
    ).toBe(true);
  });

  it("stays quiet between interval sweeps when nobody asked", async () => {
    const { shouldSweepNow } = await loadInSeparateGraph();
    expect(
      shouldSweepNow({ ...base, lastSweepStartedAtMs: 90_000, sweeping: false, nudged: false })
    ).toBe(false);
  });

  it("a nudge starts a sweep at once, without waiting for the interval", async () => {
    const { shouldSweepNow } = await loadInSeparateGraph();
    expect(
      shouldSweepNow({ ...base, lastSweepStartedAtMs: 99_000, sweeping: false, nudged: true })
    ).toBe(true);
  });

  it("never starts a second sweep while one is in flight — nudged or due", async () => {
    // The webhook path and the interval path against one ticket: the interval
    // sweep is mid-claim when the arming webhook's nudge lands. Before #163 the
    // webhook ran its own sweep on another graph and both claimed. Now the
    // nudge waits for the tick after this sweep ends.
    const { shouldSweepNow } = await loadInSeparateGraph();
    expect(
      shouldSweepNow({ ...base, lastSweepStartedAtMs: 99_000, sweeping: true, nudged: true })
    ).toBe(false);
    expect(
      shouldSweepNow({ ...base, lastSweepStartedAtMs: 60_000, sweeping: true, nudged: false })
    ).toBe(false);
  });

  it("a nudge that landed mid-sweep is still pending for the tick after", async () => {
    const m = await loadInSeparateGraph();
    m.requestAutonomySweep("mid-sweep webhook");
    // Sweep in flight: the ticker declines.
    expect(
      shouldSweepNowWith(m, { sweeping: true })
    ).toBe(false);
    // The nudge was not consumed by declining.
    expect(m.isSweepRequested()).toBe(true);
    // Sweep over: the very next tick starts the follow-up.
    expect(shouldSweepNowWith(m, { sweeping: false })).toBe(true);
  });

  function shouldSweepNowWith(m: Nudge, over: { sweeping: boolean }): boolean {
    return m.shouldSweepNow({
      nowMs: 100_000,
      lastSweepStartedAtMs: 99_500,
      intervalMs: 30_000,
      sweeping: over.sweeping,
      nudged: m.isSweepRequested(),
    });
  }
});
