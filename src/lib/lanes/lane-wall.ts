/**
 * Who is paying, and whether a lane's window has refused work (issues #173,
 * #176).
 *
 * Four small predicates, extracted from `overflow.ts` when cost routing
 * arrived and needed them too. They are still #173's rules, unchanged; what
 * changed is how many callers read them. `overflow.ts` decides the crossing,
 * `money-state.ts` reports the guards, and `lane-selection.ts` ranks lanes —
 * and all three have to agree about whether a lane can serve a request and
 * whose money it spends, so the predicates live below all three rather than
 * inside one of them. (`overflow.ts` re-exports them, so every existing
 * importer keeps naming the module that owns the *policy*.)
 *
 * A leaf: it imports the quota vocabulary and nothing else, which is what lets
 * every rule below be table-tested against a captured `rate_limit_event` with
 * no lane file, no database and no clock but the one passed in.
 */

import { quotaObservationIsSpent } from "../quota/quota-gate";
import { quotaSeverity, type QuotaObservation } from "../quota/rate-limit-event";
import type { LaneBilling, LaneCaps } from "./lane-config";

/**
 * Just what the crossing and the ranking need to know about a lane: who it
 * bills, and up to how much. Structurally satisfied by both `ResolvedLane`
 * (what a pass runs on) and `LaneView` (what the screen shows), so neither
 * caller has to translate — and neither can pass a lane the other could not
 * have.
 */
export interface CrossingLane {
  id: string;
  label: string;
  billing: LaneBilling;
  caps: LaneCaps;
}

/**
 * Is the account already paying cash for work on its subscription lane?
 *
 * Read from the overage fields the CLI puts on `rate_limit_event` — which #167
 * stores precisely because this ticket needs them — under the same
 * spent-observation rule the admission gate uses: telemetry that no longer
 * describes the account now decides nothing, and the next pass re-observes
 * within seconds.
 *
 * Two shapes count, and the second is why `isUsingOverage` alone will not do:
 *
 * - `isUsingOverage` — the request drew on overage. Definitive.
 * - the subscription window has **refused** while the overage window has not.
 *   That is the state `scripts/rate-limit-stub.mjs --scenario overage-active`
 *   reproduces (`status: rejected`, `overage-status: allowed`, HTTP 200): the
 *   wall is up, the request succeeded anyway, and the card paid for it.
 *
 * What deliberately does *not* count is `overageInUse` on its own. The real
 * captured event from a healthy account carries `overageInUse: true` with
 * `status: allowed` and `isUsingOverage: false` — overage billing is merely
 * *available* there — so keying off it would classify an ordinary
 * subscription day as cash and hold the fleet for a confirmation nobody owed.
 */
export function overagePaysNow(
  observation: QuotaObservation | null,
  now: Date
): boolean {
  if (observation === null) return false;
  if (quotaObservationIsSpent(observation, now)) return false;
  if (observation.isUsingOverage === true) return true;
  return observation.status === "rejected" && overageIsServing(observation);
}

/**
 * Whether the event reports an overage window that can still serve a request.
 *
 * Judged through the shared severity map rather than a second list of status
 * words, so a member a later CLI adds reads as `unknown` and **decides
 * nothing** — #171's rule, and this is the one place it would have been easy
 * to break: an unknown status read as "overage is serving" would suppress the
 * wall, and the attended session would stay on the walled lane instead of
 * crossing off it. Deciding nothing leaves the wall standing, the session
 * crosses onto a metered lane, and the money guards still hold the first cash
 * of the day — the safe direction on both counts.
 */
function overageIsServing(observation: QuotaObservation): boolean {
  if (observation.overageStatus === null) return false;
  const severity = quotaSeverity(observation.overageStatus);
  return severity === "ok" || severity === "warning";
}

/**
 * Whether a lane's window has refused work outright and nothing is covering it
 * — the trigger for an interactive overflow (#173) and the one thing that
 * makes a lane ineligible for cost routing however cheap it is (#176).
 *
 * Only ever true of a subscription lane: the unified-window machinery is
 * subscription-only (#165's finding 6), so a metered lane reports no quota and
 * an observation left over from a subscription lane says nothing about it. An
 * *unavailable* lane is deliberately not a wall either — a missing credential
 * is reported by #172 and routing around an operator's explicit choice is what
 * that ticket exists to refuse. A wall is different in kind: the operator's
 * choice is intact and simply cannot serve the request.
 */
export function laneIsWalled(
  lane: Pick<CrossingLane, "billing"> | null,
  observation: QuotaObservation | null,
  now: Date
): boolean {
  if (lane === null || lane.billing !== "subscription") return false;
  if (observation === null) return false;
  if (quotaObservationIsSpent(observation, now)) return false;
  if (observation.status !== "rejected") return false;
  // Paying for it is not being refused it: the pass runs on this very lane and
  // the only thing that changed is who is paying.
  return !overagePaysNow(observation, now);
}

/**
 * Whether an **overage** — rather than the lane itself — is what is being
 * billed. One predicate because three surfaces write a sentence about it (the
 * feed note, the dashboard's cards, the settings panel), and a *metered*
 * lane observed while an overage happens to be active must not be described as
 * an overage: it bills per token on its own account. Getting that condition
 * wrong on one surface is how a fleet ends up accusing a subscription lane of
 * billing per token, or the reverse.
 */
export function overageIsThePayer(
  billing: LaneBilling | null,
  overagePaying: boolean
): boolean {
  return overagePaying && billing === "subscription";
}

/** Neither the lane's kind nor an overage alone decides who paid — both do.
 * One function because the pass that spends the money and the guards that
 * measure it must agree, and #174 keys entirely off this value. */
export function effectiveBilling(
  billing: LaneBilling,
  overagePaying: boolean
): LaneBilling {
  return billing === "metered" || overagePaying ? "metered" : "subscription";
}
