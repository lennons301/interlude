/**
 * The quota admission gate (issue #171): whether the fleet may *start* new
 * autonomous work, given the last quota observation it has.
 *
 * Pure, and deliberately a leaf beside the parser rather than inside the
 * reducer, because two surfaces have to agree about it: `decideNext` refuses
 * pickup with it, and `buildFleetView` names the hold on the dashboard with
 * it. A gate computed twice is a gate that eventually disagrees with itself,
 * and the whole point of a fleet-wide hold is that every surface says the same
 * thing about whether work is being claimed.
 *
 * What it holds, and what it deliberately does not:
 *
 *  - It stops **new pickup only** — a claim, and the triage pass that is also
 *    pickup. Everything already in flight (a running turn, a review pass owed,
 *    a repair, a parked run resuming) is decided above the gate and is
 *    untouched: refusing to *finish* work already paid for would waste the
 *    quota that has already been spent on it.
 *  - It never outranks the kill switch or a project's own autonomy toggle.
 *    Those are a human's decision; this is an observation.
 *
 * Three rules make it safe to close a gate on telemetry the fleet does not
 * control:
 *
 *  - **No observation is not a closed gate.** A fresh install has never seen a
 *    `rate_limit_event`, and neither has one authenticating with an API key —
 *    the unified-window machinery is subscription-only (#165's finding 6). A
 *    metered lane must not be gated by silence it can never break.
 *  - **An absent utilization is not 0% and not 100%.** #167 established that
 *    the field is frequently missing rather than null or zero, so a missing
 *    one decides nothing either way; the status still can.
 *  - **A spent observation stops gating.** This is load-bearing, not tidiness:
 *    the only thing that produces a fresh observation is a pass making an API
 *    call, so a gate held by a stale rejection would suppress the very traffic
 *    that would lift it — the fleet would wedge until a human ran an
 *    interactive turn. An observation is spent once its stated reset has
 *    passed, or — for one that stated none — once it is older than
 *    {@link QUOTA_OBSERVATION_STALE_MS}. Reopening is self-correcting: the
 *    next pass observes the wall again within seconds and the gate closes
 *    again; never reopening costs the fleet everything.
 */

import type { QuotaObservation } from "./rate-limit-event";

/**
 * Utilization at or above which new pickup stops, when nothing overrides it.
 * Ninety leaves a tenth of the window, which is roughly one attempt's worth on
 * a 2-slot box — enough for work already in flight to finish rather than being
 * cut off mid-PR.
 *
 * **A single threshold, with no headroom reserved for the owner.** The fleet
 * and the owner's own Claude Code sessions draw on one pool and the fleet takes
 * what it takes; reserving a slice for interactive use was considered and
 * rejected in #171 as a second number to keep true.
 */
export const DEFAULT_QUOTA_PICKUP_THRESHOLD_PERCENT = 90;

/**
 * The thresholds the settings UI offers, as strings because that is what the
 * override column stores. A fixed set rather than a free number: the panel's
 * control is a chip radio, the spread is finer than the decision it feeds
 * (a fleet gated at 87 rather than 85 behaves the same), and a value outside
 * it is *rejected with the list*, never quietly clamped. `100` is the
 * effectively-off end — the gate then trips only on an outright rejection,
 * which is the one thing no threshold can turn off.
 */
export const QUOTA_THRESHOLD_OPTIONS = [
  "50",
  "70",
  "80",
  "85",
  "90",
  "95",
  "100",
] as const;

/**
 * How long an observation that stated no reset time goes on gating.
 *
 * Timed from when the fleet *saw* it, because that is the only clock such an
 * event carries — it says nothing about where in its window it sits. So the
 * worst case is genuinely bad: an event seen four hours into a five-hour window
 * holds pickup for five hours from then, roughly four hours past the real
 * reset, on a fleet with nothing else to do. That is accepted rather than
 * tightened, because the asymmetry runs the other way from the usual one:
 * reopening early does not merely cost "a probe", it costs a *ticket* one of
 * its three attempts. A rejected pass exits in about two seconds (#165's
 * finding 5) and is recorded as a failed attempt like any other, so a fleet
 * that probed every half hour through a long wall would burn three real
 * tickets to a human before the window reopened. Waiting is the cheaper
 * mistake.
 *
 * It only ever binds the reset-less case. A rejection carries `resetsAt` (#167)
 * and is released exactly at it; the events observed without one are
 * `allowed_warning`, where the fleet is stopping short on purpose and has lost
 * nothing by stopping a while longer.
 */
export const QUOTA_OBSERVATION_STALE_MS = 5 * 60 * 60 * 1000;

/** Why the gate is closed. `rejected` is the account already refusing work;
 * `utilization` is the fleet stopping short of that on purpose. */
export type QuotaGateReason = "rejected" | "utilization";

export interface QuotaGate {
  /** True = no new tickets are claimed and no triage pass is started. */
  closed: boolean;
  reason: QuotaGateReason | null;
  /** The threshold in force, carried so every surface quotes the same number. */
  thresholdPercent: number;
  /** The observation the decision was made on, or nulls when there was none. */
  status: string | null;
  rateLimitType: string | null;
  utilization: number | null;
  resetsAt: Date | null;
  observedAt: Date | null;
}

function openGate(thresholdPercent: number): QuotaGate {
  return {
    closed: false,
    reason: null,
    thresholdPercent,
    status: null,
    rateLimitType: null,
    utilization: null,
    resetsAt: null,
    observedAt: null,
  };
}

/**
 * Whether an observation still describes the account *now*. See the module
 * note: a gate that could never lift itself is worse than one that reopens a
 * little early.
 */
export function quotaObservationIsSpent(
  observation: QuotaObservation,
  now: Date
): boolean {
  if (observation.resetsAt !== null) {
    return observation.resetsAt.getTime() <= now.getTime();
  }
  return (
    now.getTime() - observation.observedAt.getTime() >=
    QUOTA_OBSERVATION_STALE_MS
  );
}

/**
 * The gate, from the last observation and the threshold in force.
 *
 * `thresholdPercent` arrives resolved (settings override over environment over
 * {@link DEFAULT_QUOTA_PICKUP_THRESHOLD_PERCENT}) so this stays pure and the
 * freshness rule lives at the call sites, where #166 put it.
 */
export function evaluateQuotaGate(
  observation: QuotaObservation | null,
  thresholdPercent: number,
  now: Date
): QuotaGate {
  if (observation === null) return openGate(thresholdPercent);
  if (quotaObservationIsSpent(observation, now)) {
    return openGate(thresholdPercent);
  }

  const seen = {
    thresholdPercent,
    status: observation.status,
    rateLimitType: observation.rateLimitType,
    utilization: observation.utilization,
    resetsAt: observation.resetsAt,
    observedAt: observation.observedAt,
  };

  // The account is already refusing requests, so there is nothing to weigh:
  // whatever the threshold says, work started now cannot run. Read verbatim
  // rather than through the severity map, which folds a status this build has
  // never seen into `unknown` — and an unknown status must not gate the fleet.
  if (observation.status === "rejected") {
    return { closed: true, reason: "rejected", ...seen };
  }

  // Absent is not zero (#167): a window that reported no utilization decides
  // nothing here, and the status above has already had its say.
  if (
    observation.utilization !== null &&
    observation.utilization >= thresholdPercent
  ) {
    return { closed: true, reason: "utilization", ...seen };
  }

  return { closed: false, reason: null, ...seen };
}
