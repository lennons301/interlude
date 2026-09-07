/**
 * "Something changed — sweep soon", recorded by a route handler and consumed by
 * the orchestrator's own loop (issue #163).
 *
 * The GitHub webhook route used to call `runAutonomySweep()` itself. That ran a
 * whole sweep on the **app-router module graph**, where every piece of the
 * sweep's module-level memory — `sweeping`, `inFlightClaims`,
 * `fleetHealthState`, each announce-dedup set — is that graph's own, freshly
 * empty copy (see `process-singleton.ts` for why there are two graphs at all).
 * Three things followed, all observed in production on 2026-09-06:
 *
 *   - two sweeps ran concurrently and **claimed the same ticket twice**, 250 ms
 *     apart, because the single-flight flag they each checked was not shared;
 *   - a webhook sweep evaluated the fleet-health signals against debounce
 *     clocks that started that instant, computed all-clear, and **overwrote a
 *     standing needs-you card** through the globalThis-backed health store —
 *     dedup memory included, so the card did not come back on the next sweep;
 *   - `isQueueRunning()` read false and `claimableSlots` overcounted, because
 *     that graph never started the queue and holds no reservations.
 *
 * Moving eleven fields onto `globalThis` one by one would fix today's list and
 * leave the next module-level `let` one commit away from reintroducing the
 * bug. So the route no longer sweeps at all: it records a nudge here, and the
 * loop that already owns every sweep picks it up on its next tick — a second
 * of latency at most, which the spec already calls acceptable ("the webhook is
 * only latency on top of this — the sweep is the backbone"). With one place
 * that sweeps, the sweep's memory can stay plain module state, and a lint rule
 * (`no-restricted-imports` in eslint.config.mjs) keeps route handlers from
 * importing the sweep module again.
 *
 * The nudge itself is the one thing both graphs touch, so it lives on
 * `globalThis` via `processSingleton`. It is a level, not an edge: a nudge that
 * arrives while a sweep is in flight stays set, so the loop runs one more
 * sweep as soon as the current one finishes rather than dropping the event
 * (the running sweep may have gathered before the event landed).
 */

import { processSingleton } from "@/lib/process-singleton";

interface SweepNudge {
  requested: boolean;
  /** When the first un-consumed nudge landed (ms), for the log line. */
  requestedAtMs: number | null;
  /** Why, deduplicated and bounded — a burst of webhooks is one sweep. */
  reasons: string[];
}

const MAX_REASONS = 8;

const nudge = processSingleton<SweepNudge>("autonomy.sweepNudge", () => ({
  requested: false,
  requestedAtMs: null,
  reasons: [],
}));

/**
 * Ask the orchestrator's loop to sweep on its next tick. Safe to call from any
 * module graph, any number of times; never sweeps itself.
 */
export function requestAutonomySweep(reason: string): void {
  nudge.requested = true;
  nudge.requestedAtMs ??= Date.now();
  if (!nudge.reasons.includes(reason) && nudge.reasons.length < MAX_REASONS) {
    nudge.reasons.push(reason);
  }
}

/** Whether a nudge is pending. Read by the loop's ticker. */
export function isSweepRequested(): boolean {
  return nudge.requested;
}

/**
 * Consume the pending nudge, if any, returning why it was asked for and how
 * long it waited. Called by the loop at the start of a sweep — and only there.
 */
export function takeSweepNudge(
  nowMs: number = Date.now()
): { reasons: string[]; waitedMs: number } | null {
  if (!nudge.requested) return null;
  const taken = {
    reasons: [...nudge.reasons],
    waitedMs: nudge.requestedAtMs == null ? 0 : Math.max(0, nowMs - nudge.requestedAtMs),
  };
  nudge.requested = false;
  nudge.requestedAtMs = null;
  nudge.reasons.length = 0;
  return taken;
}

/**
 * The loop's per-tick decision, pure so it can be tested without the sweep's
 * dependencies: sweep now when the interval is due or a nudge is pending —
 * but never while a sweep is already in flight. A nudge seen during a sweep is
 * left pending (it is a level, see above), so the tick after the sweep ends
 * starts the follow-up.
 */
export function shouldSweepNow(input: {
  nowMs: number;
  /** When the last sweep started (ms); 0 when none has. */
  lastSweepStartedAtMs: number;
  intervalMs: number;
  sweeping: boolean;
  nudged: boolean;
}): boolean {
  if (input.sweeping) return false;
  if (input.nudged) return true;
  return input.nowMs - input.lastSweepStartedAtMs >= input.intervalMs;
}
