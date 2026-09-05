/**
 * Cost-first lane selection (issue #176): which of the declared lanes a pass
 * should run on, and — when the lane it was on has been refused — which one it
 * should move to rather than waiting the window out.
 *
 * Before this, two mechanisms existed and neither crossed a lane boundary. The
 * degrade ladder (#170) steps `heavy -> standard -> light` *within* one lane;
 * overflow (#173) crosses lanes, but only for attended work, only on a wall,
 * and only onto whichever metered lane the file happened to prefer. Which lane
 * a pass ran on was otherwise a fixed setting, so a walled autonomous run
 * parked for five hours beside an idle lane costing a fortieth as much.
 *
 * **One function, three callers.** The crossing routes a pass with it, the
 * reducer decides a failover with it, and the settings screen shows what it
 * would pick — the #148 rule, because a selection computed twice is a
 * selection that eventually disagrees with itself, and the surface that says
 * "this pass will run on X" must be reading the same answer the pass gets.
 *
 * Pure, so `now`, the environment, the telemetry and the day's spend are all
 * parameters: every rule below is table-testable with no provider, no Docker
 * and no network.
 *
 * ## How lanes are ordered
 *
 * Two orderings out of one price table, because cost and capability are
 * genuinely different axes and only one of them is what the fleet pays:
 *
 * - **Cost** is what this fleet is charged at the margin. A subscription lane
 *   is *zero* — its quota is already bought — which is why cost routing leaves
 *   the shipped configuration exactly where it was: nothing is cheaper than
 *   work that is already paid for. A lane that bills per token costs its own
 *   declared blended rate. A lane that bills per token and declares **no**
 *   prices costs *unknown*, which ranks last: an unread price must be treated
 *   as expensive, because under-reading cost is how a fleet spends money
 *   nobody authorised (the same asymmetry `lane-cost.ts` argues from). An
 *   active overage moves a subscription lane into that last class too — the
 *   card is being charged and this file cannot say how much, so a lane whose
 *   price *is* written down is the cheaper choice.
 * - **Capability** is a proxy, and the only honest one available without
 *   inventing a quality ranking this ticket explicitly excludes: what the
 *   provider charges for the models the lane runs. A lane declaring no prices
 *   ranks at the *top* — it is Anthropic-direct, running first-party Claude at
 *   list rates — which is the same fact that puts it last on cost, read the
 *   other way round. This axis exists only to give a pass kind's **minimum
 *   lane** a meaning: a floor admits every lane at or above the named lane's
 *   capability, so a floor of `openrouter` still allows the subscription
 *   (free *and* first-party), and a floor of `anthropic-api` means
 *   "first-party Claude only".
 *
 * Ties break on the file's own `primary` preference order, then declaration
 * order — the deployment's reviewed statement of who it would rather pay,
 * which is what #173 used to choose an overflow target and survives here as
 * the tie-break rather than as the rule.
 *
 * ## What a pass needs of a harness
 *
 * One requirement is the pass's rather than the fleet's (issue #218): a
 * **generation session** — an interactive task carrying a session skill — has
 * to be hosted by a harness that expands a user-invoked skill, because its
 * whole first turn is that invocation, and on a harness that cannot load the
 * skill it would silently become freeform chat with a skill it never read. So
 * a lane whose adapter does not declare `userInvokedSkills` is ineligible for
 * a generation session, however cheap, and for nothing else: an ordinary chat
 * and every ticket-loop pass kind are judged exactly as before. The
 * requirement is derived from the pass (`isGenerationSession`) rather than
 * passed in as a flag, so an autonomous kind cannot be filtered by it even by
 * mistake.
 */

import { isGenerationSession, type SessionSkill } from "../../db/schema";
import type { AgentPassKind, AppConfig } from "../config";
import type { ModelTier } from "../model-tiers";
import type { QuotaObservation } from "../quota/rate-limit-event";
import type { SettingsOverrides } from "../settings-resolver";
import {
  findLane,
  type LaneAdapterId,
  type LaneBilling,
  type LaneCatalog,
  type LaneDefinition,
} from "./lane-config";
import { priceTokens, type TurnTokenUsage } from "./lane-cost";
import { effectiveBilling, laneIsWalled, overagePaysNow } from "./lane-wall";
import {
  evaluateMeteredSpend,
  resolveMeteredCap,
  type MeteredSpendState,
} from "./money";
import { laneMissingEnv, type LaneEnv } from "./resolve";

/**
 * The token mix one million tokens of an agentic pass are assumed to be, used
 * for exactly one thing: collapsing a lane's four-column price table into a
 * single comparable rate.
 *
 * It is a **ranking key, not a forecast** — what a pass actually costs is
 * charged from the same prices applied to the tokens the harness really
 * reported (`chargeForTurn`), and nothing here is ever booked against a
 * budget. The shape is read off the turns captured for #175, where a warm
 * agentic turn's dominant term is cache reads by an order of magnitude
 * (`cache_read_input_tokens: 21051` beside `input_tokens: 210` and
 * `output_tokens: 43`) and cache writes arrive whenever context is added.
 *
 * The exact weights matter far less than they look: the lanes this chooses
 * between differ by 40x on every column at once, so any mix that is not
 * perverse produces the same order. What matters is that the mix is written
 * down where it can be argued with, and that it is priced through
 * `priceTokens` — the one function that already knows an unpriced cache column
 * costs the input rate rather than nothing.
 */
export const RANKING_PASS_USAGE: TurnTokenUsage = {
  inputTokens: 100_000,
  outputTokens: 50_000,
  cacheReadTokens: 750_000,
  cacheWriteTokens: 100_000,
};

/**
 * The tier a lane's rate is read at when the pass resolves none — a deployment
 * pinning a raw model id (`AGENT_MODEL=claude-opus-4-8`), which names no tier.
 *
 * `standard` because a lane's own middle answer is the closest thing to "what
 * does this lane cost?" asked of the lane rather than of the pass, and because
 * abandoning the comparison instead would silently stop enforcing a pass
 * kind's minimum lane on exactly the deployments that pinned a model
 * deliberately. It is the same tier `laneFallbackTier` gives an unset row, for
 * the same reason.
 */
const RATE_PROXY_TIER: ModelTier = "standard";

/** Unknown, and therefore last on cost and first on capability. Named because
 * it is a decision — see the module note — rather than a missing number. */
const UNREAD_PRICE = Number.POSITIVE_INFINITY;

/**
 * What a lane charges for {@link RANKING_PASS_USAGE}, in USD per million
 * tokens, or null when it declares no prices for the tier.
 *
 * Exported because it is worth *showing*: "$0.04/Mtok" beside "$1.65/Mtok" is
 * the whole cost case, and an operator reading the settings screen should see
 * the number the routing decided on rather than be left to blend four columns
 * in their head.
 */
export function laneBlendedRateUsd(
  lane: Pick<LaneDefinition, "prices">,
  tier: ModelTier | null
): number | null {
  const prices = lane.prices?.[tier ?? RATE_PROXY_TIER];
  return prices === undefined ? null : priceTokens(prices, RANKING_PASS_USAGE);
}

/**
 * What this fleet pays at the margin to run one pass on this lane — the
 * ordering key. Zero for work already bought, the declared rate for work
 * billed per token, `UNREAD_PRICE` for cash whose rate is not written down.
 *
 * `overagePaying` is the lane's *own* observation read through
 * `overagePaysNow`: a subscription lane covered by an active overage is
 * spending cash at a rate this file cannot state, so it is not free and its
 * price is not known.
 */
export function laneCostRank(
  lane: Pick<LaneDefinition, "billing" | "prices">,
  tier: ModelTier | null,
  overagePaying: boolean
): number {
  if (effectiveBilling(lane.billing, overagePaying) === "subscription") return 0;
  return laneBlendedRateUsd(lane, tier) ?? UNREAD_PRICE;
}

/**
 * The capability proxy a minimum lane is expressed in — what the *provider*
 * charges for what this lane runs, ignoring who pays it. A lane declaring no
 * prices is Anthropic-direct and ranks at the top; see the module note.
 */
export function laneCapabilityRank(
  lane: Pick<LaneDefinition, "prices">,
  tier: ModelTier | null
): number {
  return laneBlendedRateUsd(lane, tier) ?? UNREAD_PRICE;
}

/** Why a lane was passed over. Ordered by how it is judged, not by severity:
 * a lane can be more than one of these and only the first is reported. */
export type LaneIneligibility =
  /** The fleet is pinned to another lane, so cost routing is off (#172's
   * explicit-choice rule, which this ticket must not route around). */
  | "not-pinned"
  /** Its named credentials are absent — #172's report, not a wall. */
  | "unavailable"
  /** Below this pass kind's minimum lane. */
  | "below-floor"
  /** Its own window has refused work and no overage is covering it. */
  | "walled"
  /** #174's real-money cap for this lane is spent. */
  | "cap-reached"
  /** #174's confirm-once gate has not been pressed today. */
  | "unconfirmed"
  /** The caller has already tried it — the refused lane, on a failover. */
  | "already-tried"
  /** Its harness does not expand a user-invoked skill, and this pass is a
   * generation session — the one kind of pass that is such an invocation
   * (issue #218). Never reported for any other kind. */
  | "cannot-invoke-skills";

/** One lane, judged for one pass. */
export interface LaneCandidate {
  id: string;
  label: string;
  /** The harness that runs it — for a refusal that has to say *why* a lane
   * cannot host a generation session (issue #218). */
  adapter: LaneAdapterId;
  /** What the lane declares. */
  billing: LaneBilling;
  /** What it costs *now* — `metered` when an active overage means its
   * subscription work is cash (#173). */
  effectiveBilling: LaneBilling;
  /** The ordering key; see {@link laneCostRank}. `Infinity` = unread price. */
  costRank: number;
  /** The floor's own vocabulary; see {@link laneCapabilityRank}. */
  capabilityRank: number;
  /** USD per Mtok of the ranking mix, or null when the lane declares no
   * prices — for saying so on a screen. */
  rateUsdPerMTok: number | null;
  /** The credentials it is missing, empty when it can run. */
  missingEnvVars: string[];
  /** #174's guards as judged for *this* lane's own cap; null when running
   * here would not spend cash. */
  money: MeteredSpendState | null;
  /** Why it was passed over, or null when it may run. */
  ineligible: LaneIneligibility | null;
}

export interface LaneSelectionInput {
  /** Null when the lane file could not be read — nothing to select from, and
   * #172 has already refused every pass. */
  catalog: LaneCatalog | null;
  /** Read for availability only. No secret's value is read here. */
  env: LaneEnv;
  kind: AgentPassKind;
  /**
   * The session skill an interactive task carries, or null for an ordinary
   * chat — and null for every autonomous kind, which carries none. With
   * `kind` this is what makes the pass a generation session (issue #218), the
   * one kind of pass that may only run where its skill can be invoked.
   */
  sessionSkill?: SessionSkill | null;
  /** The tier this pass resolved to; null when a raw model id is pinned. */
  tier: ModelTier | null;
  /**
   * The lane the fleet is **pinned** to — an explicit settings choice or
   * `AGENT_LANE` — or null when that choice falls through and cost routing
   * decides.
   *
   * The escape hatch the ticket requires, and deliberately not a new setting:
   * #172 already distinguishes an explicit choice (honoured even when broken,
   * because routing around an operator's decision is how a fleet spends money
   * nobody authorised) from the *unset* default that walks the file's
   * preference order. Cost routing replaces that walk and nothing else.
   *
   * A **wall releases it**, and only a wall. #173 crossed an attended session
   * off a walled lane whether or not it was pinned, and that must keep being
   * true: a pin says "do not choose for me", where a wall says the chosen lane
   * cannot serve the request at all — different in kind, which is the same
   * distinction `laneIsWalled` draws against a merely unavailable lane. So a
   * pinned fleet still fails over rather than waiting hours, and still never
   * has a lane picked for it while its own can serve the work.
   */
  pinnedLaneId: string | null;
  /**
   * The lane in force (#172's primary) — the one a pass would run on if the
   * ranking chose nothing.
   *
   * It is never excluded by the floor below. A floor bounds where routing may
   * *send* a pass; the lane in force is not a routing choice, it is the lane
   * the deployment is on, and excluding it would either silently run the pass
   * there anyway (which would make the setting a lie) or refuse a pass with
   * nowhere else to go. It is still subject to everything about whether it can
   * serve the request — a wall, and #174's money guards.
   */
  primaryLaneId: string | null;
  /** The capability floor for this pass kind, or null for none. */
  minLaneId: string | null;
  /**
   * Each lane's last quota observation, keyed by lane id (#167, per-lane since
   * #175). A lane absent from the map, or mapped to null, has reported none —
   * which is the permanent state of a metered lane, and must never read as a
   * closed door: such a lane is admitted on **spend** instead, by the money
   * guards below. That is #171's "no observation is not a closed gate", and it
   * is why this takes a map rather than one fleet-wide reading.
   */
  observations: Readonly<Record<string, QuotaObservation | null>>;
  /** Lanes the caller has already tried and must not be handed back — the
   * refused pass's own lane, on a failover. */
  excludeLaneIds?: readonly string[];
  config: AppConfig;
  overrides: SettingsOverrides;
  /** Real money already spent through metered lanes today (#174's ledger). */
  spentTodayUsd: number;
  /** When the fleet last confirmed real-money spend; null = never. */
  confirmedAt: Date | null;
  now: Date;
}

export interface LaneSelection {
  /** The lane this pass should run on; null when none may. */
  laneId: string | null;
  chosen: LaneCandidate | null;
  /** Every declared lane, cheapest first, each carrying why it was passed
   * over. The order *is* the cost case, which is why it is handed back whole
   * rather than reduced to a winner. */
  candidates: LaneCandidate[];
  /** The lane an operator's explicit choice pins the fleet to, so cost routing
   * is off; null when the choice falls through and routing decides. */
  pinnedLaneId: string | null;
  /**
   * The best lane held **only** by #174's money guards — what a refusal has to
   * quote, because "confirm real-money spend" and "there is nowhere to go"
   * are different sentences and send the human to different places. Null when
   * nothing was held for money.
   */
  heldForMoney: LaneCandidate | null;
  /** The floor that was applied, echoed for the message that names it. */
  minLaneId: string | null;
  /**
   * The lane in force, judged like any other candidate — what a pass falls
   * back to when the ranking chose nothing, so its caller reads that lane's
   * money guards from here rather than reasoning about them a second time.
   * Null when the lane in force names no declared lane.
   */
  inForce: LaneCandidate | null;
}

/**
 * Where a refused pass may move to instead of pausing — the shape the reducer
 * receives, small on purpose: it decides *whether* to move (the ordering
 * against the tier ladder and the pause, and the bound), and this says
 * *where*.
 */
export interface LaneFailoverOption {
  toLaneId: string;
  toLaneLabel: string;
  /** What running there will cost — the effective kind, so an overage-covered
   * subscription target reads as the cash it is. */
  billing: LaneBilling;
  rateUsdPerMTok: number | null;
}

/** Preference order, then declaration order — the file's own reviewed ranking,
 * used only to break a tie on cost. */
function orderingKeys(catalog: LaneCatalog): Map<string, number> {
  const keys = new Map<string, number>();
  catalog.preference.forEach((id, index) => {
    if (!keys.has(id)) keys.set(id, index);
  });
  const offset = catalog.preference.length;
  catalog.lanes.forEach((lane, index) => {
    if (!keys.has(lane.id)) keys.set(lane.id, offset + index);
  });
  return keys;
}

/**
 * Judge every declared lane for one pass and rank them cheapest first.
 *
 * Exported beside {@link selectLane} because the ranking *is* the explanation:
 * the settings screen shows it, and a test that wants to assert "GLM is 40x
 * cheaper than the subscription's overage" asserts it here rather than through
 * a winner.
 */
export function rankLanes(input: LaneSelectionInput): LaneCandidate[] {
  const { catalog } = input;
  if (catalog === null) return [];

  const excluded = new Set(input.excludeLaneIds ?? []);
  const keys = orderingKeys(catalog);
  // A wall releases the pin — see `pinnedLaneId`. Asked once, up front, because
  // it is a fact about the fleet rather than about each candidate.
  const pinned =
    input.pinnedLaneId === null ? null : findLane(catalog, input.pinnedLaneId);
  const pinHolds =
    pinned !== null &&
    !laneIsWalled(pinned, input.observations[pinned.id] ?? null, input.now);
  const floor =
    input.minLaneId === null ? null : findLane(catalog, input.minLaneId);
  // A floor naming no declared lane is ignored rather than obeyed as "nothing
  // qualifies": the file is version-controlled and the setting is not, so a
  // lane renamed in a deploy would otherwise stop the fleet dead. The settings
  // screen refuses an unknown lane id by name at the point of writing, which
  // is where that surprise belongs.
  const floorRank =
    floor === null ? null : laneCapabilityRank(floor, input.tier);
  // A generation session's first turn *is* a skill invocation, so it needs a
  // harness that expands one (issue #218). Derived here from the pass — the
  // schema's own predicate — rather than taken as a flag, so no autonomous
  // kind can be filtered by it: the predicate is false for every kind but
  // `interactive`.
  const needsSkillInvocation = isGenerationSession({
    kind: input.kind,
    sessionSkill: input.sessionSkill ?? null,
  });

  const candidates = catalog.lanes.map((lane): LaneCandidate => {
    const observation = input.observations[lane.id] ?? null;
    const overagePaying = overagePaysNow(observation, input.now);
    const billing = effectiveBilling(lane.billing, overagePaying);
    const missingEnvVars = laneMissingEnv(lane, input.env);

    // #174's guards, evaluated per lane over that lane's own declared cap —
    // its own functions, not a second copy of them, so a lane's eligibility
    // here and the hold the dashboard renders are the same judgement.
    const money =
      billing === "metered"
        ? evaluateMeteredSpend({
            billing,
            spentUsd: input.spentTodayUsd,
            capUsd: resolveMeteredCap(
              input.config,
              input.overrides,
              lane.caps.dailyBudgetUsd
            ).capUsd,
            confirmedAt: input.confirmedAt,
            now: input.now,
          })
        : null;

    const capabilityRank = laneCapabilityRank(lane, input.tier);

    return {
      id: lane.id,
      label: lane.label,
      adapter: lane.adapter,
      billing: lane.billing,
      effectiveBilling: billing,
      costRank: laneCostRank(lane, input.tier, overagePaying),
      capabilityRank,
      rateUsdPerMTok: laneBlendedRateUsd(lane, input.tier),
      missingEnvVars,
      money,
      ineligible: judge({
        laneId: lane.id,
        pinnedLaneId: pinHolds ? input.pinnedLaneId : null,
        // The lane in force answers to everything except the floor.
        exemptFromFloor: lane.id === input.primaryLaneId,
        excluded,
        cannotInvokeSkills:
          needsSkillInvocation && !lane.capabilities.userInvokedSkills,
        missingEnvVars,
        capabilityRank,
        floorRank,
        walled: laneIsWalled(lane, observation, input.now),
        money,
      }),
    };
  });

  return candidates.sort(
    (a, b) =>
      a.costRank - b.costRank ||
      (keys.get(a.id) ?? 0) - (keys.get(b.id) ?? 0)
  );
}

/**
 * Why one lane may not serve this pass, in the order the reasons are asked.
 *
 * The order is the message, not an implementation detail: an operator's pin
 * outranks everything (it is a decision, not an observation), a harness that
 * cannot host the pass outranks a missing credential (setting the variable
 * would not help — issue #218), a missing credential outranks a wall (#172's
 * report is about configuration and a wall is about capacity), and a money
 * hold is asked *last* so a lane the floor excluded anyway never asks for a
 * confirmation nobody needs to give.
 */
function judge(args: {
  laneId: string;
  pinnedLaneId: string | null;
  exemptFromFloor: boolean;
  excluded: Set<string>;
  /** The pass is a generation session and this lane's harness does not
   * expand a user-invoked skill. */
  cannotInvokeSkills: boolean;
  missingEnvVars: string[];
  capabilityRank: number;
  floorRank: number | null;
  walled: boolean;
  money: MeteredSpendState | null;
}): LaneIneligibility | null {
  if (args.pinnedLaneId !== null && args.laneId !== args.pinnedLaneId) {
    return "not-pinned";
  }
  if (args.excluded.has(args.laneId)) return "already-tried";
  if (args.cannotInvokeSkills) return "cannot-invoke-skills";
  if (args.missingEnvVars.length > 0) return "unavailable";
  // A *lower* capability rank is a cheaper — and so, by this proxy, a weaker —
  // lane than the floor names. Equal passes: the floor is inclusive, which is
  // what makes naming a lane in it mean "this one, or better".
  if (
    !args.exemptFromFloor &&
    args.floorRank !== null &&
    args.capabilityRank < args.floorRank
  ) {
    return "below-floor";
  }
  if (args.walled) return "walled";
  if (args.money?.hold === "cap-reached") return "cap-reached";
  if (args.money?.hold === "unconfirmed") return "unconfirmed";
  return null;
}

/** Whether a candidate was stopped only by #174's money guards — a press or a
 * midnight away from running, as opposed to unusable. */
function heldForMoneyOnly(candidate: LaneCandidate): boolean {
  return (
    candidate.ineligible === "unconfirmed" ||
    candidate.ineligible === "cap-reached"
  );
}

/**
 * The lane one pass should run on: the cheapest that is available, permitted
 * and at or above its pass kind's floor.
 */
export function selectLane(input: LaneSelectionInput): LaneSelection {
  const candidates = rankLanes(input);
  const chosen = candidates.find((lane) => lane.ineligible === null) ?? null;

  return {
    laneId: chosen?.id ?? null,
    chosen,
    candidates,
    pinnedLaneId: input.pinnedLaneId,
    heldForMoney: candidates.find(heldForMoneyOnly) ?? null,
    minLaneId: input.minLaneId,
    inForce:
      candidates.find((lane) => lane.id === input.primaryLaneId) ?? null,
  };
}

/**
 * The ranking as it stands for a pass its lane's quota window has refused
 * (issues #176, #199, #202): every declared lane judged for the pass, with the
 * refused lane excluded and a pin naming it released.
 *
 * Deliberately a thin read of {@link selectLane} rather than a second search:
 * "which lane should this pass run on?" is the same question whether it is
 * being asked for the first time or after a wall, and asking it twice in two
 * ways is how the routing and the failover would come to disagree about which
 * lane is cheapest.
 *
 * Handed back *whole* because two readers want different halves of it. The
 * reducer wants only the winner ({@link planLaneFailover}), since its job is
 * whether and when to move. The operator's manual move (issue #202) wants the
 * losers too: refused, it has to say *why* nowhere can serve the run — a lane
 * a press would free is a different sentence from a lane missing a credential
 * — and `heldForMoney` and each candidate's `ineligible` are where that
 * answer already lives.
 *
 * Note what it does *not* consult: a lane's quota telemetry is read per lane,
 * so the walled lane's rejection can never be held against a lane that reports
 * none. Such a lane is admitted on spend — the money guards above — which is
 * what makes an autonomous move onto a paid lane answer to #174's cap and
 * confirm-once press rather than to somebody else's utilization.
 */
export function selectLaneFailover(
  input: LaneSelectionInput & { fromLaneId: string | null }
): LaneSelection {
  const { fromLaneId } = input;
  return selectLane({
    ...input,
    // Being called at all *is* the wall, for this lane: the caller is holding
    // the turn's own rejection, which is a fresher and more authoritative
    // reading than the recorded observation `rankLanes` would consult. So a
    // pin naming the lane that just refused the pass is released here rather
    // than left to that row — which the stream parser does write at the moment
    // of observation (#167), but relying on the timing of a second reading of
    // a fact already in hand is how a pinned fleet would silently lose its
    // failover.
    pinnedLaneId:
      input.pinnedLaneId !== null && input.pinnedLaneId === fromLaneId
        ? null
        : input.pinnedLaneId,
    excludeLaneIds: [
      ...(input.excludeLaneIds ?? []),
      ...(fromLaneId === null ? [] : [fromLaneId]),
    ],
  });
}

/** The winner of a failover ranking as the reducer receives it, or null when
 * nothing was chosen — the reduction {@link planLaneFailover} makes, exported
 * so a caller holding the whole selection can make the same one. */
export function failoverOption(
  selection: LaneSelection
): LaneFailoverOption | null {
  if (selection.chosen === null) return null;
  return {
    toLaneId: selection.chosen.id,
    toLaneLabel: selection.chosen.label,
    billing: selection.chosen.effectiveBilling,
    rateUsdPerMTok: selection.chosen.rateUsdPerMTok,
  };
}

/**
 * Where a pass refused by its lane's quota window may move to (issue #176), or
 * null when there is nowhere both available and permitted — in which case the
 * run pauses on the window's clock exactly as it did before this ticket.
 *
 * {@link selectLaneFailover} reduced to its winner: the shape the reducer
 * receives, small on purpose, because it decides *whether* to move (the
 * ordering against the tier ladder and the pause, and the bound) and this
 * says *where*.
 */
export function planLaneFailover(
  input: LaneSelectionInput & { fromLaneId: string | null }
): LaneFailoverOption | null {
  return failoverOption(selectLaneFailover(input));
}
