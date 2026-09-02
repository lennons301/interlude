/**
 * The crossing (issue #173): what happens to a pass when the subscription
 * window has refused it, and when the account is already paying cash for work
 * it believes is quota.
 *
 * Two rules live here, and both are decided *before* a container is
 * provisioned:
 *
 * - **Interactive work overflows; autonomous work does not.** A human is
 *   sitting there waiting, so a walled subscription lane routes an interactive
 *   pass onto an available metered lane rather than failing it or leaving it
 *   queued. An autonomous pass takes no such route: it runs, is refused in
 *   about two seconds (#165's finding 5), and its run parks on the window's
 *   clock (#168/#169). That asymmetry is the whole point — unattended work
 *   never starts spending real money because a window closed.
 * - **An active overage is a paid lane.** Overage billing means the account is
 *   already being charged rather than drawing on quota, and an account with it
 *   enabled would otherwise never show a `rejected` at all: the wall would
 *   silently become a bill. So a pass running under an active overage is
 *   booked as metered spend and answers to the same money guards a metered
 *   lane does (#174) — no overflow needed, because the lane in force is
 *   already the paid one.
 *
 * What it does **not** own. The cap, the confirm-once-per-local-day gate and
 * the cap-outranks-confirmation precedence are #174's, evaluated here through
 * its own `evaluateMeteredSpend` rather than restated — a second copy of "may
 * the fleet spend cash?" is a second answer waiting to disagree with the
 * dashboard's. And the *choice* of primary lane is #172's: the primary arrives
 * as a parameter, already resolved, so this module can never disagree with the
 * settings screen about which lane work runs on.
 *
 * Pure, so `now`, the environment and the telemetry are all parameters: the
 * turn manager (which routes a pass), the queue loop (which declines to start
 * one) and the UI (which asks the human to confirm) evaluate the same function
 * over the same facts, and cannot describe the crossing differently.
 */

import type { AgentPassKind, AppConfig } from "../config";
import { quotaObservationIsSpent } from "../quota/quota-gate";
import type { QuotaObservation } from "../quota/rate-limit-event";
import type { SettingsOverrides } from "../settings-resolver";
import {
  findLane,
  type LaneBilling,
  type LaneCaps,
  type LaneCatalog,
  type LaneDefinition,
} from "./lane-config";
import {
  evaluateMeteredSpend,
  resolveMeteredCap,
  type MeteredSpendState,
} from "./money";
import { laneIsAvailable, laneMissingEnv, type LaneEnv } from "./resolve";

/**
 * Just what the crossing needs to know about a lane: who it bills, and up to
 * how much. Structurally satisfied by both `ResolvedLane` (what a pass runs
 * on) and `LaneView` (what the screen shows), so neither caller has to
 * translate — and neither can pass a lane the other could not have.
 */
export interface CrossingLane {
  id: string;
  label: string;
  billing: LaneBilling;
  caps: LaneCaps;
}

/** Why a pass may not start. Not a money hold on its own — `cap-reached` and
 * `unconfirmed` are #174's two holds arriving at an attended session, and
 * `no-metered-lane` is this ticket's own: walled, with nowhere to overflow. */
export type CrossingRefusalReason =
  | "no-metered-lane"
  | "unconfirmed"
  | "cap-reached";

export interface CrossingRefusal {
  reason: CrossingRefusalReason;
  /** What to tell the human — the whole reason this is refused rather than
   * silently queued, so it is written where the decision is made rather than
   * at three call sites. */
  message: string;
}

export interface LaneCrossing {
  /** The lane this pass should run on: the primary, or the overflow target.
   * Null only when no lane resolves at all, which is #172's refusal, not
   * this module's. */
  laneId: string | null;
  /** How this pass's spend must be booked — the lane's own billing kind, or
   * `metered` when an active overage means subscription work is cash. Null
   * when no lane resolved. */
  billing: LaneBilling | null;
  /** The walled lane this pass overflowed off; null when it did not overflow. */
  overflowedFrom: string | null;
  /** The primary lane's window has refused work, and no overage is covering
   * it. False on a metered primary, which reports no quota at all. */
  walled: boolean;
  /** The account is paying cash for work on a subscription lane. */
  overage: boolean;
  /** Why this pass may not start, or null when it may. Only ever set for an
   * interactive pass: refusing an autonomous one here would stop work the
   * reducer has already decided to run, and #174's guards deliberately hold
   * *pickup* rather than in-flight passes. */
  refusal: CrossingRefusal | null;
  /** The money guards as judged for the lane named above; null when this
   * pass's spend is not cash. */
  money: MeteredSpendState | null;
  /** A line worth putting on the task's feed — an overflow, or subscription
   * work that has started costing money. Null when there is nothing new to
   * say. */
  notice: string | null;
}

export interface LaneCrossingInput {
  kind: AgentPassKind;
  /** The primary lane, as #172 resolved it; null when none resolves. */
  primary: CrossingLane | null;
  /** The declared lanes, or null when the file could not be read (in which
   * case there is nothing to overflow onto and #172 has already refused). */
  catalog: LaneCatalog | null;
  /** The orchestrator's environment — read for availability only, never for a
   * secret's value. */
  env: LaneEnv;
  /** The fleet's last quota observation (#167), or null when no pass has
   * reported one. */
  observation: QuotaObservation | null;
  config: AppConfig;
  overrides: SettingsOverrides;
  /** Real money already spent through metered lanes today (#174's ledger). */
  spentTodayUsd: number;
  /** When the fleet last confirmed real-money spend; null = never. */
  confirmedAt: Date | null;
  now: Date;
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
  return observation.status === "rejected" && overageIsAvailable(observation);
}

/** Whether the event reports an overage window that could still serve a
 * request. A status this build has never seen counts as available: the only
 * consequence is treating the work as paid, which errs towards asking the
 * human before spending rather than spending without asking. */
function overageIsAvailable(observation: QuotaObservation): boolean {
  return (
    observation.overageStatus !== null &&
    observation.overageStatus !== "rejected"
  );
}

/**
 * Whether the primary lane's window has refused work outright and nothing is
 * covering it — the trigger for an interactive overflow.
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
  primary: CrossingLane | null,
  observation: QuotaObservation | null,
  now: Date
): boolean {
  if (primary === null || primary.billing !== "subscription") return false;
  if (observation === null) return false;
  if (quotaObservationIsSpent(observation, now)) return false;
  if (observation.status !== "rejected") return false;
  // Paying for it is not being refused it: the pass runs on this very lane and
  // the only thing that changed is who is paying.
  return !overagePaysNow(observation, now);
}

/**
 * The lanes an interactive pass may overflow onto, best first.
 *
 * Preference order first, then declaration order: the file's `primary` list is
 * the deployment's own stated ranking of who it would rather pay (Anthropic
 * direct before a third party, in the shipped file), and honouring it here
 * means the overflow target is a reviewed decision rather than whichever lane
 * happens to be declared first.
 */
export function meteredOverflowCandidates(
  catalog: LaneCatalog | null,
  env: LaneEnv,
  excludeLaneId: string | null
): LaneDefinition[] {
  if (catalog === null) return [];
  const preferred = catalog.preference
    .map((id) => findLane(catalog, id))
    .filter((lane): lane is LaneDefinition => lane !== null);
  const ordered = [...preferred, ...catalog.lanes];

  const seen = new Set<string>();
  const candidates: LaneDefinition[] = [];
  for (const lane of ordered) {
    if (lane.id === excludeLaneId || seen.has(lane.id)) continue;
    seen.add(lane.id);
    if (lane.billing !== "metered") continue;
    if (!laneIsAvailable(lane, env)) continue;
    candidates.push(lane);
  }
  return candidates;
}

/** Every declared metered lane and the variables it is missing — the "told
 * why" half of refusing an overflow with nowhere to go. Reached only when no
 * candidate resolved, so a lane with nothing missing is (by construction) the
 * lane already in force. */
function describeUnavailableMeteredLanes(
  catalog: LaneCatalog | null,
  env: LaneEnv
): string {
  const metered = (catalog?.lanes ?? []).filter(
    (lane) => lane.billing === "metered"
  );
  if (metered.length === 0) {
    return "no lane in lanes.yaml bills per token";
  }
  // `laneMissingEnv` rather than a second reading of `auth`: what makes a lane
  // unavailable is answered in exactly one place (issue #172).
  const unavailable = metered
    .map((lane) => ({ id: lane.id, missing: laneMissingEnv(lane, env) }))
    .filter((lane) => lane.missing.length > 0);
  if (unavailable.length === 0) {
    return "the only lane that bills per token is the one already in force";
  }
  return unavailable
    .map((lane) => `${lane.id} needs ${lane.missing.join(", ")}`)
    .join("; ");
}

/** `$12.34` — the same shape the dashboard's money reads in, written here so a
 * refusal quotes the cap the way the settings panel does. */
function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** `14:05` in the fleet's own local time, or null when the event named no
 * reset. Deliberately not a locale format: this string is asserted in tests
 * and read on a phone, and both want the same two numbers. */
function atClockTime(at: Date | null): string | null {
  if (at === null) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** "The Claude subscription window is exhausted (resets 14:05)" — the sentence
 * every crossing message opens with, so the human reads the cause before the
 * consequence. */
function wallSentence(
  primary: CrossingLane,
  observation: QuotaObservation | null
): string {
  const resets = atClockTime(observation?.resetsAt ?? null);
  return (
    `The ${primary.label} window is exhausted` +
    (resets === null ? "" : ` (resets ${resets})`)
  );
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

/** Only work a human is waiting on overflows, and only it is refused before it
 * starts. Every autonomous kind pauses instead (#168/#169). */
function isAttendedPass(kind: AgentPassKind): boolean {
  return kind === "interactive";
}

/**
 * The crossing for one pass: which lane it runs on, how its spend is booked,
 * and whether it may start at all.
 */
export function decideLaneCrossing({
  kind,
  primary,
  catalog,
  env,
  observation,
  config,
  overrides,
  spentTodayUsd,
  confirmedAt,
  now,
}: LaneCrossingInput): LaneCrossing {
  const overage = overagePaysNow(observation, now);
  const walled = laneIsWalled(primary, observation, now);

  const base: LaneCrossing = {
    laneId: primary?.id ?? null,
    billing:
      primary === null ? null : effectiveBilling(primary.billing, overage),
    overflowedFrom: null,
    walled,
    overage,
    refusal: null,
    money: null,
    notice: null,
  };

  // An autonomous pass is routed, never held: #168 parks its run on the
  // window's clock, and #174's guards hold the *pickup* that starts one rather
  // than a pass already under way. All this decides for it is who pays, so an
  // overage-funded pass books its dollars as the cash they are.
  if (primary === null || !isAttendedPass(kind)) return base;

  // Overflow: a walled subscription lane hands an attended pass to the best
  // available metered lane. With none available there is nothing to hand it
  // to, and saying so beats provisioning a container to be refused in two
  // seconds.
  let lane: CrossingLane = primary;
  let overflowedFrom: string | null = null;
  if (walled) {
    const [target] = meteredOverflowCandidates(catalog, env, primary.id);
    if (target === undefined) {
      return {
        ...base,
        refusal: {
          reason: "no-metered-lane",
          message:
            `${wallSentence(primary, observation)} and there is no paid lane to ` +
            `overflow onto — ${describeUnavailableMeteredLanes(catalog, env)}.`,
        },
      };
    }
    lane = target;
    overflowedFrom = primary.id;
  }

  const billing = effectiveBilling(lane.billing, overage);
  if (billing === "subscription") {
    // Nothing here costs money, so nothing here is guarded: subscription-lane
    // interactive work is exactly as exempt from the cash cap as it was.
    return { ...base, laneId: lane.id, billing };
  }

  // From here the pass spends real money, however it got there — an overflow,
  // an overage, or a metered lane the operator made primary. #174's guards
  // decide, over its own cap resolution, so the sentence this pass shows the
  // human quotes the same numbers the settings panel does.
  const cap = resolveMeteredCap(config, overrides, lane.caps.dailyBudgetUsd);
  const money = evaluateMeteredSpend({
    billing,
    spentUsd: spentTodayUsd,
    capUsd: cap.capUsd,
    confirmedAt,
    now,
  });

  const crossed: LaneCrossing = {
    ...base,
    laneId: lane.id,
    billing,
    overflowedFrom,
    money,
    notice: noticeFor(lane, primary, observation, overflowedFrom, overage, money),
  };

  if (money.hold === "cap-reached") {
    return {
      ...crossed,
      notice: null,
      refusal: {
        reason: "cap-reached",
        message:
          `Capped: today's real-money limit of ${usd(money.capUsd)} is spent ` +
          `(${usd(money.spentUsd)} on metered lanes). This session stops here ` +
          `rather than spending past it — raise the cap on the settings screen, ` +
          `or continue after midnight.`,
      },
    };
  }

  if (money.hold === "unconfirmed") {
    const lead =
      overflowedFrom === null
        ? whyPaid(lane, primary, observation, overage)
        : `${wallSentence(primary, observation)}, so this session would ` +
          `continue on ${lane.label} — which bills per token`;
    return {
      ...crossed,
      notice: null,
      refusal: {
        reason: "unconfirmed",
        message:
          `${lead}. ` +
          `Real money: ${usd(money.spentUsd)} of ${usd(money.capUsd)} spent today. ` +
          `Confirm real-money spend to continue; the rest of today's spend then ` +
          `runs without asking, up to the cap.`,
      },
    };
  }

  return crossed;
}

/** Why this pass costs money when it is not an overflow: an overage on the
 * lane in force, or a lane that simply bills per token. */
function whyPaid(
  lane: CrossingLane,
  primary: CrossingLane,
  observation: QuotaObservation | null,
  overage: boolean
): string {
  if (overage && lane.billing === "subscription") {
    return (
      `${wallSentence(primary, observation)} and the account's overage is ` +
      `covering it, so this session is already spending real money`
    );
  }
  return `${lane.label} bills per token, so this session spends real money`;
}

/** The line a permitted crossing puts on the task's feed. Written for someone
 * who was mid-conversation and is about to see the same session cost money. */
function noticeFor(
  lane: CrossingLane,
  primary: CrossingLane,
  observation: QuotaObservation | null,
  overflowedFrom: string | null,
  overage: boolean,
  money: MeteredSpendState
): string {
  const spend = `Real money: ${usd(money.spentUsd)} of ${usd(money.capUsd)} spent today.`;
  if (overflowedFrom !== null) {
    return (
      `${wallSentence(primary, observation)} — continuing on ${lane.label}, ` +
      `which bills per token. ${spend}`
    );
  }
  if (overage && lane.billing === "subscription") {
    return (
      `${wallSentence(primary, observation)} and the account's overage is ` +
      `covering it — this session is spending real money. ${spend}`
    );
  }
  return `${lane.label} bills per token. ${spend}`;
}
