/**
 * Fleet-health watchdog (issue #126). Four observations make a silent pickup or
 * review stall loud instead of invisible (the parent #115 incident hid a wedged
 * frontier behind a dashboard that showed a free slot and ready tickets):
 *
 *   (a) owed-review stalled — a run awaiting review whose pass never started;
 *   (b) pickup wedged — a free slot but queued work not dispatching;
 *   (c) stale queue heartbeat — the 2s poll loop stopped making progress.
 *   (d) phantom occupancy — the in-memory slot counter claims more busy slots
 *       than there are agent containers actually running (issue #152).
 *
 * (b) and (d) are one signal with two ways in, not two mechanisms: both mean
 * "work will not dispatch", both surface as the same pickup-wedged card and
 * one-time ping. (d) exists because (b) reads `occupiedSlots()` to decide a slot
 * is free, so when *occupancy itself* is the lie — a leaked reservation holding
 * a slot with no container behind it (#151) — the watchdog was silent by
 * construction, on the one input it trusted. Corroborating the counter against
 * what the daemon actually reports is the only way to see that shape.
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
  /** Occupancy uncorroborated by real containers for longer than this is a
   * phantom slot (issue #152, default 20 min). Deliberately far longer than
   * `pickupWedgedMs`: a task that has reserved its slot but not yet created its
   * container is legitimately uncorroborated for the whole of provisioning,
   * which includes a cold agent-image build — and this card's remedy is a
   * restart, which would kill that task. See DEFAULT_OCCUPANCY_DIVERGED_MS. */
  occupancyDivergedMs: number;
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

/** A queued task that could take a slot if one were really free. */
export interface QueuedTaskObservation {
  taskId: string;
  /** Human context, e.g. "review: owner/repo#34". */
  label: string;
}

/**
 * What the Docker daemon actually reports about agent containers — the reality
 * the in-memory slot counter is checked against (issue #152).
 *
 * `live` is the running set, the same question the memory-admission probe
 * already asks the daemon. `stopped` is every other agent container that still
 * exists — a parked autonomous pass (stopped to free memory since #93) and any
 * exited container the reaper has not collected yet. Only `live` can be holding
 * a slot, and `occupiedSlots()` excludes parked entries for exactly that reason,
 * so a parked container cancels on both sides and never reads as a divergence;
 * `stopped` is carried for the card, so the operator sees the whole picture
 * rather than a bare zero.
 */
export interface AgentContainerCensus {
  /** Agent containers running right now. */
  live: number;
  /** Agent containers that exist but are stopped (parked, or awaiting reaping). */
  stopped: number;
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
  /** Queued tasks that reserve a slot and are waiting for one. Gathered every
   * sweep, not only when a slot reads free: when occupancy is the lie (#152)
   * there is no free slot to gather them behind, and a task starved by a
   * phantom slot is precisely what must still be surfaced. */
  queuedDispatchable: QueuedTaskObservation[];
  /** What the daemon says is really running, or null when the probe failed or
   * timed out. Null is *unknown*, and unknown decides nothing: an unhealthy
   * daemon must not manufacture a wedge any more than it may freeze dispatch
   * (#128), and equally must not clear a divergence already being counted. */
  agentContainers: AgentContainerCensus | null;
  /** Whether the 2s queue poll loop is running at all. A stopped loop is boot
   * or shutdown, not a wedge, so it never alarms. */
  queueRunning: boolean;
  /** The queue loop's last-progress stamp (ms); null before its first tick. */
  queueLastProgressMs: number | null;
}

export interface OwedReviewStall extends OwedReviewObservation {
  stalledForMs: number;
}

/** Which way into the pickup-wedged card fired — `dispatch` is a free slot with
 * work that will not start, `phantom-slot` is a slot count no real container
 * corroborates (issue #152). They are one card because they mean the same thing
 * to the fleet, and two causes because they have different remedies: the ping
 * is deduped on this, so a card that *upgrades* from one to the other tells the
 * operator once more rather than silently changing its advice. */
export type PickupWedgeCause = "dispatch" | "phantom-slot";

export interface PickupWedge {
  cause: PickupWedgeCause;
  /** Human-readable specifics for the card/ping body. */
  detail: string;
  wedgedForMs: number;
  /** What the operator should do about it, in one sentence. Decided here so the
   * dashboard card and the Discord ping can never advise differently: a phantom
   * slot is only cleared by a restart, an ordinary wedge is something to go and
   * look at. */
  remedy: string;
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
  /** First-seen a free slot with work that will not dispatch (ms), or null. */
  pickupWedgedSinceMs: number | null;
  /** First-seen occupancy-uncorroborated (ms), or null once the daemon has
   * positively agreed with the counter. A census that could not be taken holds
   * this rather than clearing it — unknown is not agreement. Held separately
   * from `pickupWedgedSinceMs` because the two conditions run on different
   * thresholds, even though they raise one card. */
  occupancyDivergedSinceMs: number | null;
  /** Which cause was last pinged, or null when the card is not standing. Keyed
   * on the cause rather than a bare flag so one occurrence pings once, but a
   * wedge that changes character — and so changes its remedy — pings again. */
  pickupWedgedAnnounced: PickupWedgeCause | null;
  queueStaleAnnounced: boolean;
}

export const EMPTY_FLEET_HEALTH_STATE: FleetHealthState = {
  owedReviewSinceMs: {},
  owedReviewAnnounced: [],
  pickupWedgedSinceMs: null,
  occupancyDivergedSinceMs: null,
  pickupWedgedAnnounced: null,
  queueStaleAnnounced: false,
};

export const DEFAULT_FLEET_HEALTH_THRESHOLDS: FleetHealthThresholds = {
  owedReviewStallMs: 30 * 60_000,
  pickupWedgedMs: 3 * 60_000,
  heartbeatStaleMs: 2 * 60_000,
  occupancyDivergedMs: 20 * 60_000,
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

  // --- (b) Pickup wedged, and (d) phantom occupancy ------------------------
  // Two conditions, two since-timers, two thresholds — one card. Either way in
  // means the same thing to the operator: claimable work is not going to run.
  const slotFree = input.slots.occupied < input.slots.total;
  const wedgedNow =
    slotFree &&
    (input.pickupPausedWithFreeSlot || input.queuedDispatchable.length > 0);
  const pickupWedgedSinceMs = wedgedNow ? (prev.pickupWedgedSinceMs ?? now) : null;
  const wedgedForMs = pickupWedgedSinceMs == null ? 0 : now - pickupWedgedSinceMs;
  const wedgeFires = wedgedNow && wedgedForMs >= thresholds.pickupWedgedMs;

  // The counter claims more busy slots than there are agent containers running.
  // Strictly one-directional: *more* containers than counted slots is a parked
  // pass mid-transition or a leaked container — the memory-admission probe's
  // business, never a pickup wedge. Held as the census itself rather than a
  // flag, so the detail below reads the very numbers it was judged on.
  const diverged =
    input.agentContainers != null &&
    input.slots.occupied > input.agentContainers.live
      ? input.agentContainers
      : null;
  // A census that could not be taken is *unknown*, and unknown decides nothing
  // in either direction: it may not manufacture a divergence, and it may not
  // erase one. Only the daemon positively agreeing clears the clock (AC3).
  // Erasing on unknown was a real hole — the census has a 5s bound and runs
  // once per 30s sweep, so a 20-minute threshold needed 40 *consecutive*
  // answers, and a daemon degraded enough to time out now and then is the
  // likeliest companion of a real phantom (#125, #128). The clock would have
  // restarted on every hiccup and the card never fired.
  const occupancyDivergedSinceMs =
    diverged != null
      ? (prev.occupancyDivergedSinceMs ?? now)
      : input.agentContainers != null
        ? null
        : prev.occupancyDivergedSinceMs;
  const divergedForMs =
    occupancyDivergedSinceMs == null ? 0 : now - occupancyDivergedSinceMs;
  // Firing still demands a *current* positive observation, so however long the
  // clock has run, a daemon that cannot answer never raises this card — whose
  // advice is "restart", which would not help an unresponsive daemon anyway.
  const divergenceFires =
    diverged != null && divergedForMs >= thresholds.occupancyDivergedMs;

  // A phantom slot leads when both hold: it explains the wedge, and it is the
  // half with a different remedy. The starved work is named either way.
  const pickupWedged: PickupWedge | null =
    divergenceFires && diverged
      ? {
          cause: "phantom-slot",
          detail: divergedOccupancyDetail(input, diverged),
          // How long the fleet has been in this state — the longer-standing of
          // the two conditions, counting the dispatch wedge only once it fires.
          wedgedForMs: Math.max(divergedForMs, wedgeFires ? wedgedForMs : 0),
          remedy: PHANTOM_SLOT_REMEDY,
        }
      : wedgeFires
        ? {
            cause: "dispatch",
            detail: pickupWedgeDetail(input),
            wedgedForMs,
            remedy: PICKUP_WEDGE_REMEDY,
          }
        : null;
  // One card, pinged once per occurrence: while it stands the ping is
  // suppressed, and inside a debounce window the memory is carried rather than
  // reset, so a condition flickering over threshold doesn't re-ping. Once
  // neither condition holds at all it clears and the next occurrence pings
  // afresh — as does a standing card that *upgrades* its cause, because its
  // remedy changed with it.
  //
  // Deliberately asymmetric, and only upwards. A downgrade means we learned
  // less, not that the fleet recovered: the way it happens is a sweep whose
  // census could not be taken while a dispatch wedge stands, and re-pinging
  // there would demote "restart the app" to "go and look" on a box that still
  // has a phantom slot. So the memory keeps the highest cause the occurrence
  // has reached, and an unresolved divergence keeps the card standing even on a
  // sweep that could not observe it.
  const divergenceStanding = occupancyDivergedSinceMs != null;
  const pickupWedgedAnnounced =
    wedgedNow || divergenceStanding
      ? highestCause(pickupWedged?.cause ?? null, prev.pickupWedgedAnnounced)
      : (pickupWedged?.cause ?? null);
  const announcePickupWedged =
    pickupWedged != null &&
    causeRank(pickupWedged.cause) > causeRank(prev.pickupWedgedAnnounced)
      ? pickupWedged
      : null;

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
      occupancyDivergedSinceMs,
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

/** Go and look: the slot accounting is honest, so the stall is somewhere in the
 * dispatch path. */
const PICKUP_WEDGE_REMEDY =
  "The queue is not picking up claimable work — check the orchestrator " +
  "(a hung Docker daemon or a stuck poll loop).";

/** Nothing frees a phantom slot but a fresh process: the count lives only in
 * orchestrator memory, so no label, no cancel and no container action reaches
 * it (issue #152). */
const PHANTOM_SLOT_REMEDY =
  "The slot count is held in orchestrator memory with nothing behind it — " +
  "restart the app to clear it.";

/** How much a cause tells the operator, so the ping can fire on an *upgrade*
 * without firing on the loss of information that is a downgrade. `null` is "no
 * card announced yet", below both. */
function causeRank(cause: PickupWedgeCause | null): number {
  if (cause === "phantom-slot") return 2;
  if (cause === "dispatch") return 1;
  return 0;
}

function highestCause(
  a: PickupWedgeCause | null,
  b: PickupWedgeCause | null
): PickupWedgeCause | null {
  return causeRank(a) >= causeRank(b) ? a : b;
}

function pickupWedgeDetail(input: FleetHealthInput): string {
  const free = input.slots.total - input.slots.occupied;
  const freeSlots = `${free} slot${free === 1 ? "" : "s"} free`;
  const starved = starvedWorkPhrase(input);
  if (starved) return `${freeSlots} but ${starved}`;
  return `${freeSlots} but pickup is paused (no-slots)`;
}

/** Names the divergence in the operator's terms — the counter's claim against
 * the daemon's answer — because that is what tells them the count is the fault
 * and a restart is the fix. */
function divergedOccupancyDetail(
  input: FleetHealthInput,
  census: AgentContainerCensus
): string {
  const occupied = input.slots.occupied;
  const claim = `occupancy says ${occupied} slot${occupied === 1 ? "" : "s"} busy`;
  const reality = `${census.live} agent container${census.live === 1 ? "" : "s"} live`;
  const stopped = census.stopped > 0 ? ` (${census.stopped} stopped)` : "";
  const starved = starvedWorkPhrase(input);
  return `${claim} but the daemon reports ${reality}${stopped}${
    starved ? ` — ${starved}` : ""
  }`;
}

/** The waiting work, named on whichever card fires. */
function starvedWorkPhrase(input: FleetHealthInput): string | null {
  const queued = input.queuedDispatchable;
  if (queued.length === 0) return null;
  const more = queued.length > 1 ? ` (+${queued.length - 1} more)` : "";
  return `"${queued[0].label}" has not dispatched${more}`;
}
