/**
 * The crossing (issue #173): what happens to a pass when the subscription
 * window has refused it, and when the account is already paying cash for work
 * it believes is quota.
 *
 * Two rules live here, and both are decided *before* a container is
 * provisioned:
 *
 * - **A walled lane is routed off, and only attended work is ever *held*.**
 *   A human sitting there waiting is why an attended pass crosses onto a paid
 *   lane; issue #176 extended the crossing itself to autonomous work, because
 *   parking a run for five hours beside an idle lane costing a fortieth as
 *   much is worse than paying for it — but every dollar of that still answers
 *   to #174's cap and confirm-once press, so unattended work never *starts*
 *   spending real money on its own. What stayed asymmetric is the refusal: an
 *   attended pass that may not run is told why and held, where an autonomous
 *   one is left on its lane to be refused in about two seconds (#165's
 *   finding 5) and parked on the window's clock (#168/#169). Which lane any
 *   pass runs on is `lane-selection.ts`'s answer now, cheapest-first — this
 *   module owns what happens *because* of a wall, not the ranking.
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
import type { ModelTier } from "../model-tiers";
import type { QuotaObservation } from "../quota/rate-limit-event";
import type { SettingsOverrides } from "../settings-resolver";
import {
  findLane,
  type LaneBilling,
  type LaneCatalog,
} from "./lane-config";
import { selectLane, type LaneSelection } from "./lane-selection";
import {
  effectiveBilling,
  laneIsWalled,
  overageIsThePayer,
  overagePaysNow,
  type CrossingLane,
} from "./lane-wall";
import type { MeteredSpendState } from "./money";
import { laneIsAvailable, laneMissingEnv, type LaneEnv } from "./resolve";

/**
 * The four predicates that answer "can this lane serve the request, and whose
 * money would it spend?" live in `lane-wall.ts` (issue #176), below this
 * module, `money-state.ts` and `lane-selection.ts` — all three read them and
 * all three have to agree. They are re-exported here because the *policy* they
 * serve is still this module's, and because every existing caller names it.
 */
export {
  effectiveBilling,
  laneIsWalled,
  overageIsThePayer,
  overagePaysNow,
  type CrossingLane,
} from "./lane-wall";

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
  /** The lane in force's last quota observation (#167, per-lane since #175),
   * or null when no pass on it has reported one. */
  observation: QuotaObservation | null;
  /**
   * Every lane's last observation, keyed by lane id — what cost routing needs
   * to know which lanes can serve a request (issue #176). The lane in force's
   * own entry is overlaid from `observation` above, so the wall this module
   * writes a sentence about and the wall the ranking excludes a lane for are
   * one reading of one row.
   *
   * Optional because most lanes never have one: a metered provider gives no
   * quota telemetry at all (#165's finding 6), and #171's rule that silence is
   * not a closed gate is exactly what lets an absent entry mean "admitted on
   * spend instead".
   */
  observations?: Readonly<Record<string, QuotaObservation | null>>;
  /**
   * The lane an operator has explicitly chosen — the settings screen's
   * `primaryLane`, or `AGENT_LANE` — which **pins the fleet and turns cost
   * routing off** (issue #176). Null when that choice falls through the file's
   * preference order, which is the state a fresh deployment is in and the one
   * routing decides.
   *
   * Deliberately not a new setting: #172 already distinguishes an explicit
   * choice (honoured even when broken) from the unset default, and cost
   * routing replaces only the latter.
   */
  pinnedLaneId?: string | null;
  /** The capability floor for this pass kind (issue #176), or null for none. */
  minLaneId?: string | null;
  /** The tier this pass resolved to — the row of each lane's price table the
   * ranking reads. Null when a raw model id is pinned. */
  tier?: ModelTier | null;
  config: AppConfig;
  overrides: SettingsOverrides;
  /** Real money already spent through metered lanes today (#174's ledger). */
  spentTodayUsd: number;
  /** When the fleet last confirmed real-money spend; null = never. */
  confirmedAt: Date | null;
  now: Date;
}

/** Why there was nowhere to send a walled attended pass — the "told why" half
 * of refusing an overflow with nowhere to go. Reached only when the ranking
 * found nothing eligible and nothing a press would free, so every metered lane
 * is missing a credential, excluded by the pass kind's floor, or is the walled
 * lane itself. */
function describeUnavailableMeteredLanes(
  catalog: LaneCatalog | null,
  env: LaneEnv,
  selection: LaneSelection
): string {
  const metered = (catalog?.lanes ?? []).filter(
    (lane) => lane.billing === "metered"
  );
  if (metered.length === 0) {
    return "no lane in lanes.yaml bills per token";
  }
  const clauses: string[] = [];
  // `laneMissingEnv` rather than a second reading of `auth`: what makes a lane
  // unavailable is answered in exactly one place (issue #172).
  for (const lane of metered) {
    const missing = laneMissingEnv(lane, env);
    if (missing.length > 0) clauses.push(`${lane.id} needs ${missing.join(", ")}`);
  }
  // The floor is an operator's own setting, so a pass held by one must say so
  // rather than read as a broken deployment (issue #176).
  const belowFloor = selection.candidates
    .filter((lane) => lane.ineligible === "below-floor")
    .map((lane) => lane.id);
  if (belowFloor.length > 0 && selection.minLaneId !== null) {
    clauses.push(
      `${belowFloor.join(", ")} ${belowFloor.length === 1 ? "is" : "are"} below ` +
        `this pass kind's minimum lane (${selection.minLaneId})`
    );
  }
  if (selection.pinnedLaneId !== null) {
    clauses.push(`the fleet is pinned to ${selection.pinnedLaneId}`);
  }
  if (clauses.length === 0) {
    return "the only lane that bills per token is the one already in force";
  }
  return clauses.join("; ");
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

/**
 * Whether a pass's payer differs from what its task last recorded — what makes
 * a crossing *news* rather than a line repeated on every turn.
 *
 * The obvious test, "is this sentence already the last thing on the feed?", is
 * not enough on its own: the sentence quotes the day's running spend and the
 * window's reset, so a session driven through a walled afternoon would post a
 * line each turn that differed by a few cents. The recorded pair is the honest
 * comparison, and it lives in a column rather than in memory, so it survives a
 * restart mid-session — and it is the same pair the money ledger reads, so the
 * thing announced and the thing charged cannot part company.
 */
export function payerChanged(
  recorded: { lane: string | null; laneBilling: LaneBilling | null },
  pass: { laneId: string; billing: LaneBilling }
): boolean {
  return recorded.lane !== pass.laneId || recorded.laneBilling !== pass.billing;
}

/** Only work a human is waiting on overflows, and only it is refused before it
 * starts. Every autonomous kind pauses instead (#168/#169). */
function isAttendedPass(kind: AgentPassKind): boolean {
  return kind === "interactive";
}

/**
 * The crossing for one pass: which lane it runs on, how its spend is booked,
 * and whether it may start at all.
 *
 * Which lane is the cost ranking's answer (issue #176) rather than a fixed
 * setting: the cheapest lane that is available, permitted and at or above the
 * pass kind's floor, with a walled lane excluded however cheap it is. In the
 * shipped configuration that is a no-op until a wall — a subscription's quota
 * is already bought, so nothing is cheaper — which is exactly the property
 * that made cost routing safe to make the default.
 */
export function decideLaneCrossing({
  kind,
  primary,
  catalog,
  env,
  observation,
  observations = {},
  pinnedLaneId = null,
  minLaneId = null,
  tier = null,
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

  if (primary === null) return base;

  // An **unavailable** lane in force is not something to route around. A
  // missing credential is #172's report, and papering over a misconfiguration
  // by quietly spending money at another provider is the exact failure that
  // ticket exists to refuse — where a wall is different in kind, because the
  // operator's choice is intact and simply cannot serve the request. So the
  // pass stays where it was sent and dies with the variables named, as before.
  const inForce = catalog === null ? null : findLane(catalog, primary.id);
  if (inForce === null || !laneIsAvailable(inForce, env)) return base;

  const selection = selectLane({
    catalog,
    env,
    kind,
    tier,
    pinnedLaneId,
    primaryLaneId: primary.id,
    minLaneId,
    // One reading of the lane in force's row: whatever the caller passed for
    // every other lane, this module's own `observation` decides for the
    // primary, so the wall it writes a sentence about and the wall the ranking
    // excludes it for cannot differ.
    observations: { ...observations, [primary.id]: observation },
    config,
    overrides,
    spentTodayUsd,
    confirmedAt,
    now,
  });

  // The lane this pass runs on: the ranking's pick, or — when it picked nothing
  // — the lane in force, which is where the pass was sent and where #172's
  // report or #168's pause will answer for it. Either way it is a *judged*
  // candidate, so its money guards are read from the same evaluation the
  // ranking made rather than skipped: falling back must never be a way onto a
  // paid lane the fleet is not permitted to spend on.
  const target = selection.chosen ?? selection.inForce;
  if (target === null) return base;

  const billing = target.effectiveBilling;
  const overflowedFrom = target.id === primary.id ? null : primary.id;
  if (billing === "subscription") {
    // Nothing here costs money, so nothing here is guarded: subscription-lane
    // work is exactly as exempt from the cash cap as it was.
    const crossed = { ...base, laneId: target.id, billing, overflowedFrom };
    return selection.chosen === null
      ? refusedCrossing(crossed, selection, {
          kind,
          primary,
          catalog,
          env,
          observation,
          overage,
          walled,
        })
      : crossed;
  }

  // From here the pass spends real money, however it got there — a failover, an
  // overflow, an overage, or a metered lane the operator made primary. #174's
  // guards decided it, inside the ranking and over that lane's own cap, so the
  // sentence this pass shows the human quotes the same numbers the settings
  // panel does.
  const crossed: LaneCrossing = {
    ...base,
    laneId: target.id,
    billing,
    overflowedFrom,
    money: target.money,
    notice: noticeFor(
      target,
      primary,
      observation,
      overflowedFrom,
      overage,
      walled,
      target.money!
    ),
  };

  return target.money?.hold === null && selection.chosen !== null
    ? crossed
    : refusedCrossing(crossed, selection, {
        kind,
        primary,
        catalog,
        env,
        observation,
        overage,
        walled,
      });
}

/**
 * What to say when the pass cannot run where it is pointed.
 *
 * An **attended** pass is held and told why, because the two things holding it
 * are a press away and a midnight away. An autonomous one is not: refusing it
 * here would stop work the reducer has already decided to run, and #174's
 * guards hold *pickup* rather than a pass under way — so it is left where it
 * was sent, refused there in about two seconds, and parked on the window's
 * clock by #168 (or moved by #176's failover, which asks this same ranking
 * where to go).
 *
 * `crossed` is the pass as routed — the lane it would run on and that lane's
 * own money state — so the refusal is *about* that lane unless the thing a
 * press would free is a different one, which is the walled case: there the
 * lane in force cannot serve the request at all and the news is the lane the
 * session would move onto.
 */
function refusedCrossing(
  crossed: LaneCrossing,
  selection: LaneSelection,
  at: {
    kind: AgentPassKind;
    primary: CrossingLane;
    catalog: LaneCatalog | null;
    env: LaneEnv;
    observation: QuotaObservation | null;
    overage: boolean;
    walled: boolean;
  }
): LaneCrossing {
  if (!isAttendedPass(at.kind)) return crossed;

  // The lane the pass would run on, when a press or a midnight is what stands
  // between it and running — otherwise the best lane that a press *would*
  // free, which is what a walled session needs told.
  const onTarget = crossed.money?.hold != null;
  const held = onTarget
    ? { id: crossed.laneId!, label: laneLabel(selection, crossed.laneId), money: crossed.money! }
    : selection.heldForMoney === null
      ? null
      : {
          id: selection.heldForMoney.id,
          label: selection.heldForMoney.label,
          money: selection.heldForMoney.money!,
        };

  if (held === null) {
    // Nothing is a press away. Only a wall is worth a refusal here: any other
    // reason a lane could not serve the pass is #172's to report as the pass
    // starts, and inventing a hold on top would only hide it.
    if (!at.walled) return crossed;
    return {
      ...crossed,
      notice: null,
      refusal: {
        reason: "no-metered-lane",
        message:
          `${wallSentence(at.primary, at.observation)} and there is no paid lane to ` +
          `overflow onto — ${describeUnavailableMeteredLanes(at.catalog, at.env, selection)}.`,
      },
    };
  }

  const money = held.money;
  const about: LaneCrossing = onTarget
    ? { ...crossed, notice: null }
    : {
        ...crossed,
        notice: null,
        laneId: held.id,
        billing: "metered",
        overflowedFrom: held.id === at.primary.id ? null : at.primary.id,
        money,
      };

  if (money.hold === "cap-reached") {
    return {
      ...about,
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

  // The lead names the cause the human is looking at: a wall they can see on
  // the dashboard, or — with the lane in force still serving — why the work in
  // front of them costs money at all.
  const lead =
    at.walled && held.id !== at.primary.id
      ? `${wallSentence(at.primary, at.observation)}, so this session would ` +
        `continue on ${held.label} — which bills per token`
      : whyPaid(
          { label: held.label, billing: laneBilling(selection, held.id) },
          at.primary,
          at.observation,
          at.overage,
          held.id === at.primary.id
        );
  return {
    ...about,
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

/** A ranked lane's human-facing name, from the ranking that judged it — never
 * a second lookup, so the sentence names the lane the decision was about. */
function laneLabel(selection: LaneSelection, laneId: string | null): string {
  return (
    selection.candidates.find((lane) => lane.id === laneId)?.label ??
    laneId ??
    "the lane in force"
  );
}

/** What a ranked lane *declares* it bills, as opposed to what it costs now —
 * the question `overageIsThePayer` asks. */
function laneBilling(selection: LaneSelection, laneId: string): LaneBilling {
  return (
    selection.candidates.find((lane) => lane.id === laneId)?.billing ??
    "metered"
  );
}

/**
 * Why this pass costs money when no wall sent it anywhere: an overage on the
 * lane in force, or a lane that simply bills per token.
 *
 * The overage question is asked of the **lane in force**, not of the lane this
 * pass would run on. They were the same thing before cost routing; now a pass
 * can be routed off an overage-paying subscription onto a lane whose price is
 * written down, and the news the human needs is still that their plan's quota
 * is gone and the card is being charged (issue #176).
 */
function whyPaid(
  lane: Pick<CrossingLane, "label" | "billing">,
  primary: CrossingLane,
  observation: QuotaObservation | null,
  overage: boolean,
  /** Whether `lane` *is* the lane in force. */
  onPrimary: boolean
): string {
  if (overageIsThePayer(primary.billing, overage)) {
    const lead =
      `${wallSentence(primary, observation)} and the account's overage is ` +
      `covering it, so this session is already spending real money`;
    return onPrimary
      ? lead
      : `${lead}; it would continue on ${lane.label}, which bills per token`;
  }
  return `${lane.label} bills per token, so this session spends real money`;
}

/** The line a permitted crossing puts on the task's feed. Written for someone
 * who was mid-conversation and is about to see the same session cost money. */
function noticeFor(
  lane: Pick<CrossingLane, "label" | "billing">,
  primary: CrossingLane,
  observation: QuotaObservation | null,
  overflowedFrom: string | null,
  overage: boolean,
  /** Whether the lane in force has actually refused work — the one thing that
   * licenses the wall sentence. Cost routing can move a pass with no wall
   * anywhere in sight (issue #176), and a notice that announced an exhausted
   * window then would be telling the human something untrue. */
  walled: boolean,
  money: MeteredSpendState
): string {
  const spend = `Real money: ${usd(money.spentUsd)} of ${usd(money.capUsd)} spent today.`;
  if (walled && overflowedFrom !== null) {
    return (
      `${wallSentence(primary, observation)} — continuing on ${lane.label}, ` +
      `which bills per token. ${spend}`
    );
  }
  if (overageIsThePayer(primary.billing, overage)) {
    const cause =
      `${wallSentence(primary, observation)} and the account's overage is ` +
      `covering it — this session is spending real money`;
    return overflowedFrom === null
      ? `${cause}. ${spend}`
      : `${cause}, so it continues on ${lane.label}, which bills per token. ${spend}`;
  }
  if (overflowedFrom !== null) {
    return (
      `Routed to ${lane.label}, the cheapest lane available — it bills per ` +
      `token. ${spend}`
    );
  }
  return `${lane.label} bills per token. ${spend}`;
}
