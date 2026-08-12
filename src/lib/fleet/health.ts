/**
 * Fleet-health watchdog (issue #126). Three signals make a silent pickup or
 * review stall loud instead of invisible (the parent #115 incident hid a wedged
 * frontier behind a dashboard that showed a free slot and ready tickets):
 *
 *   (a) owed-review stalled — a run awaiting review whose pass never started;
 *   (b) pickup wedged — a free slot but queued work not dispatching;
 *   (c) stale queue heartbeat — the 2s poll loop stopped making progress.
 *
 * `evaluateFleetHealth` is pure. It takes the current observations, the prior
 * evaluation's memory (per-signal since-timers plus which signals were already
 * announced) and the thresholds, and returns:
 *   - `signals`  — every currently-active problem, one dashboard needs-you card;
 *   - `announce` — the subset that JUST crossed threshold, one Discord ping each
 *                  (so a ping fires once per occurrence, not every 30s sweep);
 *   - `state`    — the memory to carry into the next evaluation.
 *
 * The sweep holds `state` in a module variable across sweeps, exactly like the
 * saturation/daily-cap announcement flags it sits beside. Kept here in the
 * fleet read-model dir, and pure, so the dashboard, the digest and the Discord
 * ping can never disagree about the state of the fleet.
 */

export interface FleetHealthThresholds {
  /** A run owed a review whose pass hasn't started for longer than this is
   * stalled (default 30 min). */
  owedReviewStallMs: number;
  /** Pickup wedged — a free slot but queued work not dispatching, or pickup
   * paused no-slots while a slot is free — for longer than this is surfaced
   * (default 3 min). The debounce also stops a single-sweep race (a slot just
   * freed, a claim about to dispatch) from flapping the card. */
  pickupWedgedMs: number;
  /** The queue poll loop going without progress longer than this is stale
   * (default 2 min ≈ 60 missed 2s polls). */
  heartbeatStaleMs: number;
}

/** A run owed a review whose pass has not started — no review container is
 * running: either no review task exists yet, or one is queued but starved of a
 * slot. A review that is actually running is progressing, not stalled, and is
 * deliberately excluded upstream. */
export interface OwedReviewObservation {
  runId: string;
  /** "owner/repo#n" */
  issueRef: string;
  prNumber: number;
  prUrl: string | null;
  /** Why the review can't run right now — e.g. "a slot is held by an
   * interactive session". Surfaced verbatim on the card. */
  reason: string;
}

/** A queued task that could take a slot while one sits free. */
export interface QueuedTaskObservation {
  taskId: string;
  /** Human context, e.g. "review: owner/repo#34". */
  label: string;
}

export interface FleetHealthInput {
  /** Evaluation time in ms. */
  nowMs: number;
  /** Runs owed a review with no review pass running. */
  owedReviews: OwedReviewObservation[];
  slots: { total: number; occupied: number };
  /** Pickup paused for no-slots (claimableSlots === 0) while a slot is free —
   * the accounting-orphan wedge shape (#115). */
  pickupPausedWithFreeSlot: boolean;
  /** Queued dispatchable tasks observed while a slot is free — the exact
   * incident shape: a review left queued while a slot sits open. */
  queuedWhileSlotFree: QueuedTaskObservation[];
  /** Whether the 2s queue poll loop is running at all. A stopped loop is boot
   * or shutdown, not a wedge, so it never alarms. */
  queueRunning: boolean;
  /** The queue loop's last-progress stamp (ms); null before its first tick. */
  queueLastProgressMs: number | null;
}

export interface OwedReviewStall extends OwedReviewObservation {
  stalledForMs: number;
}

export interface PickupWedge {
  /** Human-readable specifics for the card/ping body. */
  detail: string;
  wedgedForMs: number;
}

export interface QueueStale {
  staleForMs: number;
}

/** The currently-active health problems — one dashboard needs-you card each. */
export interface FleetHealthSignals {
  owedReviewStalls: OwedReviewStall[];
  pickupWedged: PickupWedge | null;
  queueStale: QueueStale | null;
}

/** The subset that just became active this evaluation — one Discord ping each. */
export interface FleetHealthAnnounce {
  owedReviewStalls: OwedReviewStall[];
  pickupWedged: PickupWedge | null;
  queueStale: QueueStale | null;
}

/** Cross-sweep memory: when each condition first became true, and which have
 * already been announced (so a ping fires once per occurrence, not per sweep). */
export interface FleetHealthState {
  /** runId -> first-seen owed-and-not-started (ms). A run absent from the next
   * evaluation's owed set is not re-seeded, so its timer resets — the card and
   * the dedup both clear automatically when the review starts, lands, or the run
   * finalizes. */
  owedReviewSinceMs: Record<string, number>;
  /** runIds whose stall was already pinged; kept while still stalled, pruned
   * when the run is no longer owed. */
  owedReviewAnnounced: string[];
  /** First-seen wedged (ms), or null when not wedged. */
  pickupWedgedSinceMs: number | null;
  pickupWedgedAnnounced: boolean;
  queueStaleAnnounced: boolean;
}

export const EMPTY_FLEET_HEALTH_STATE: FleetHealthState = {
  owedReviewSinceMs: {},
  owedReviewAnnounced: [],
  pickupWedgedSinceMs: null,
  pickupWedgedAnnounced: false,
  queueStaleAnnounced: false,
};

export const DEFAULT_FLEET_HEALTH_THRESHOLDS: FleetHealthThresholds = {
  owedReviewStallMs: 30 * 60_000,
  pickupWedgedMs: 3 * 60_000,
  heartbeatStaleMs: 2 * 60_000,
};

export interface FleetHealthEvaluation {
  signals: FleetHealthSignals;
  announce: FleetHealthAnnounce;
  state: FleetHealthState;
}

export function evaluateFleetHealth(
  input: FleetHealthInput,
  prev: FleetHealthState,
  thresholds: FleetHealthThresholds
): FleetHealthEvaluation {
  const now = input.nowMs;

  // --- (a) Owed-review stalled -------------------------------------------
  const owedReviewSinceMs: Record<string, number> = {};
  const owedReviewStalls: OwedReviewStall[] = [];
  const announcedStalls: OwedReviewStall[] = [];
  const owedReviewAnnounced: string[] = [];
  for (const obs of input.owedReviews) {
    // Carry the first-seen time forward. A run that dropped out of the owed set
    // (review started/landed, or the run finalized) is simply not re-seeded, so
    // its timer and its announced-flag reset and the card clears on its own.
    const since = prev.owedReviewSinceMs[obs.runId] ?? now;
    owedReviewSinceMs[obs.runId] = since;
    const stalledForMs = now - since;
    if (stalledForMs < thresholds.owedReviewStallMs) continue;

    const stall: OwedReviewStall = { ...obs, stalledForMs };
    owedReviewStalls.push(stall);
    owedReviewAnnounced.push(obs.runId);
    if (!prev.owedReviewAnnounced.includes(obs.runId)) announcedStalls.push(stall);
  }

  // --- (b) Pickup wedged --------------------------------------------------
  const slotFree = input.slots.occupied < input.slots.total;
  const wedgedNow =
    slotFree &&
    (input.pickupPausedWithFreeSlot || input.queuedWhileSlotFree.length > 0);
  let pickupWedgedSinceMs: number | null = null;
  let pickupWedged: PickupWedge | null = null;
  let pickupWedgedAnnounced = false;
  let announcePickupWedged: PickupWedge | null = null;
  if (wedgedNow) {
    pickupWedgedSinceMs = prev.pickupWedgedSinceMs ?? now;
    const wedgedForMs = now - pickupWedgedSinceMs;
    if (wedgedForMs >= thresholds.pickupWedgedMs) {
      pickupWedged = { detail: pickupWedgeDetail(input), wedgedForMs };
      pickupWedgedAnnounced = true;
      if (!prev.pickupWedgedAnnounced) announcePickupWedged = pickupWedged;
    } else {
      // Still inside the debounce window: carry the (still-false) announced flag.
      pickupWedgedAnnounced = prev.pickupWedgedAnnounced;
    }
  }
  // else: not wedged — since-timer and announced flag stay reset, re-arming.

  // --- (c) Stale queue heartbeat -----------------------------------------
  let queueStale: QueueStale | null = null;
  let queueStaleAnnounced = false;
  let announceQueueStale: QueueStale | null = null;
  if (input.queueRunning && input.queueLastProgressMs != null) {
    const staleForMs = now - input.queueLastProgressMs;
    if (staleForMs >= thresholds.heartbeatStaleMs) {
      queueStale = { staleForMs };
      queueStaleAnnounced = true;
      if (!prev.queueStaleAnnounced) announceQueueStale = queueStale;
    }
  }
  // A healthy idle loop still completes a cycle every 2s, keeping the stamp
  // fresh — only a hung or dead loop goes stale, so an idle fleet never alarms.

  return {
    signals: { owedReviewStalls, pickupWedged, queueStale },
    announce: {
      owedReviewStalls: announcedStalls,
      pickupWedged: announcePickupWedged,
      queueStale: announceQueueStale,
    },
    state: {
      owedReviewSinceMs,
      owedReviewAnnounced,
      pickupWedgedSinceMs,
      pickupWedgedAnnounced,
      queueStaleAnnounced,
    },
  };
}

/** A coarse "34m" / "1h 30m" for a health duration. Shared by the dashboard
 * card and the Discord ping so the same `stalledForMs` never renders a minute
 * apart between them (both floor). Durations here are minutes-to-hours and shown
 * at 30s sweep granularity, so seconds are noise. */
export function formatDuration(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${hrs}h ${rem}m` : `${hrs}h`;
}

function pickupWedgeDetail(input: FleetHealthInput): string {
  const free = input.slots.total - input.slots.occupied;
  const freeSlots = `${free} slot${free === 1 ? "" : "s"} free`;
  if (input.queuedWhileSlotFree.length > 0) {
    const first = input.queuedWhileSlotFree[0];
    const more =
      input.queuedWhileSlotFree.length > 1
        ? ` (+${input.queuedWhileSlotFree.length - 1} more)`
        : "";
    return `${freeSlots} but "${first.label}" has not dispatched${more}`;
  }
  return `${freeSlots} but pickup is paused (no-slots)`;
}
