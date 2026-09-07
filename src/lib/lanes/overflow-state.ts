/**
 * The impure half of routing and the crossing (issues #173, #176): gather the
 * facts `selectLane` ranks and `decideLaneCrossing` judges, once, in one
 * place.
 *
 * Four callers ask the same question from four different places — the turn
 * manager routing a pass onto a lane, the reducer deciding where a refused
 * pass moves, the queue loop declining to start an attended pass it cannot pay
 * for, and the settings endpoint the task screen asks so it can put the
 * confirmation in front of the human. Asked four times over four reads, they
 * would eventually answer differently, and the screen would offer a
 * confirmation for a crossing the orchestrator was not making.
 *
 * Built on `readMoneyGuards` rather than beside it, so "which lane, at what
 * cap, spent how much" keeps the single answer issue #174 gave it — this adds
 * only the quota telemetry, the pass kind, and the two things routing needs
 * that nothing else did: every lane's window, and this pass kind's floor.
 */

import type { SessionSkill } from "../../db/schema";
import {
  getConfig,
  resolveAgentModelChoice,
  type AgentPassKind,
} from "../config";
import { getQuotaObservations } from "../quota/quota-store";
import { getFleetSettings, type FleetSettings } from "../settings";
import { resolveMinLane } from "../settings-resolver";
import { getLaneCatalog } from "./catalog";
import {
  failoverOption,
  selectLane,
  selectLaneFailover,
  type LaneFailoverOption,
  type LaneSelection,
  type LaneSelectionInput,
} from "./lane-selection";
import { actionableObservations } from "./lane-wall";
import { readMoneyGuards, type MoneyGuards } from "./money-state";
import { decideLaneCrossing, type LaneCrossing } from "./overflow";
import { settingsPinnedTo } from "./lane-pin";

/**
 * Everything the pure ranking needs, read fresh.
 *
 * `ticketModel` is a ticket's `model:` directive (already normalised to a tier
 * by the directive parser), so the rate a lane is ranked at is the row of its
 * price table this pass would actually be charged from — the same resolution
 * `resolveLane` makes, rather than a second guess at it.
 */
function laneSelectionInput(
  kind: AgentPassKind,
  ticketModel: string | null,
  now: Date,
  settings: FleetSettings,
  /** The money guards, already read. Passed in rather than read here so a
   * caller that also needs them — `readLaneCrossing`, which describes the wall
   * on the lane in force — makes exactly one read: two would each count the
   * day's cash separately, and a booking landing between them would leave the
   * ranking and the sentence describing it disagreeing by a few cents. */
  guards: MoneyGuards,
  /** The session skill an interactive task carries (issue #218); null for an
   * ordinary chat and for every autonomous kind, which is what the failover
   * and paused-run readers below always pass. */
  sessionSkill: SessionSkill | null = null
): LaneSelectionInput {
  const config = getConfig();
  const catalog = getLaneCatalog();

  return {
    catalog: catalog.ok ? catalog.catalog : null,
    // Availability only. No secret's *value* leaves this call: routing decides
    // which lane, and `resolveLane` is still the only reader of a credential.
    env: process.env,
    kind,
    sessionSkill,
    tier: resolveAgentModelChoice(kind, config, ticketModel, settings.overrides)
      .tier,
    // An operator's explicit choice pins the fleet and turns the ranking off
    // (issue #172's own distinction, not a new setting) — until a wall, which
    // releases it, because a lane that cannot serve the request is a different
    // thing from one the operator would rather not use.
    pinnedLaneId: guards.pinnedLaneId,
    // The lane in force, which the floor below never excludes: a floor bounds
    // where routing may *send* a pass, and this is the lane the deployment is
    // already on.
    primaryLaneId: guards.lane?.id ?? null,
    minLaneId: resolveMinLane(kind, config, settings.overrides).laneId,
    // Every lane's window, because whether a lane can serve a request is a
    // fact about that lane (issue #175's per-lane keying). A lane with no row
    // is absent here, which the ranking reads as "no observation" — never as a
    // closed door, since a metered provider reports none at all. A row under a
    // lane whose *harness* reports no quota is dropped for the same reason
    // (issue #219): it is nothing the fleet may act on.
    observations: catalog.ok
      ? actionableObservations(catalog.catalog, getQuotaObservations())
      : {},
    config,
    overrides: settings.overrides,
    spentTodayUsd: guards.spentTodayUsd,
    confirmedAt: settings.meteredSpendConfirmedAt,
    now,
  };
}

/**
 * What cost routing would pick for one pass kind right now, with every lane it
 * passed over and why — what the settings screen shows, so the surface that
 * says "this pass will run on X" is reading the answer the pass gets.
 */
export function readLaneSelection(
  kind: AgentPassKind,
  ticketModel: string | null = null,
  now: Date = new Date(),
  settings: FleetSettings = getFleetSettings()
): LaneSelection {
  return selectLane(
    laneSelectionInput(
      kind,
      ticketModel,
      now,
      settings,
      readMoneyGuards(now, settings)
    )
  );
}

/**
 * The whole failover ranking for a pass its lane's quota window has refused
 * (issues #176, #199, #202): every declared lane judged, with the refused lane
 * excluded, cheapest first.
 *
 * The same ranking `readLaneSelection` reads, with the refused lane excluded:
 * "which lane should this pass run on?" is one question, and asking it a
 * second way after a wall is how the routing and the failover would come to
 * disagree about which lane is cheapest. Read whole here for the operator's
 * manual move of a parked run (issue #202), which — refused — has to say *why*
 * no lane can serve the run, and that answer is in the losers rather than in
 * the winner.
 */
export function readLaneFailoverSelection(
  kind: AgentPassKind,
  ticketModel: string | null,
  fromLaneId: string | null,
  now: Date = new Date(),
  settings: FleetSettings = getFleetSettings(),
  /** The money guards, when the caller has already read them this instant —
   * the sweep asks this once per paused run (issue #199) and has one read of
   * the day's cash in hand for the whole tick, so re-counting it here would
   * only let the rankings of two runs on one sweep disagree by a booking that
   * landed between them. */
  guards: MoneyGuards = readMoneyGuards(now, settings)
): LaneSelection {
  return selectLaneFailover({
    ...laneSelectionInput(kind, ticketModel, now, settings, guards),
    fromLaneId,
  });
}

/**
 * Where a pass its lane's quota window has refused may move to instead of
 * pausing (issue #176), or null when there is nowhere both available and
 * permitted — in which case #168's pause is what happens, exactly as before.
 *
 * {@link readLaneFailoverSelection} reduced to its winner, which is all the
 * reducer needs: it decides whether and when to move, and this says where.
 */
export function readLaneFailover(
  kind: AgentPassKind,
  ticketModel: string | null,
  fromLaneId: string | null,
  now: Date = new Date(),
  settings: FleetSettings = getFleetSettings(),
  guards: MoneyGuards = readMoneyGuards(now, settings)
): LaneFailoverOption | null {
  return failoverOption(
    readLaneFailoverSelection(kind, ticketModel, fromLaneId, now, settings, guards)
  );
}

/**
 * The crossing for one pass, as the fleet stands right now.
 *
 * Everything is read fresh — the settings row (which carries the cap, the
 * confirmation and the floors), every lane's quota row (which carries the
 * walls) and the day's cash — so a confirmation pressed on the screen reaches
 * the next poll rather than the next restart. The lane *file* is the one cached
 * read, because it cannot change without a deploy.
 *
 * `sessionSkill` is the task's (issue #218): with `kind` it says whether this
 * pass is a generation session, which may only be routed to a lane whose
 * harness can invoke its skill and is refused rather than started as chat when
 * none can. Null — an ordinary chat, or any autonomous kind — changes nothing.
 *
 * `lanePin` is the task's or run's operator pin (issue #241), or null to route
 * as the fleet does.
 */
export function readLaneCrossing(
  kind: AgentPassKind,
  ticketModel: string | null = null,
  sessionSkill: SessionSkill | null = null,
  now: Date = new Date(),
  fleetSettings: FleetSettings = getFleetSettings(),
  lanePin: string | null = null
): LaneCrossing {
  // A pinned pass (issue #241) is judged against settings whose explicit lane
  // is the pin — the fleet's own notion of "the operator chose this lane",
  // scoped to one pass. See `lane-pin.ts` for why that is the whole mechanism.
  const settings = settingsPinnedTo(fleetSettings, lanePin);
  // One read of the guards, shared with the ranking below: the lane in force,
  // whether that choice pins the fleet, that lane's quota row and the day's
  // cash all have to describe the same instant, or the wall this crossing
  // writes a sentence about and the wall the ranking excludes a lane for could
  // be two different readings.
  const guards = readMoneyGuards(now, settings);
  const selection = laneSelectionInput(
    kind,
    ticketModel,
    now,
    settings,
    guards,
    sessionSkill
  );

  return decideLaneCrossing({
    kind,
    sessionSkill,
    // The lane in force, from the same read the dashboard and the sweep make,
    // so this can never describe a wall on a lane other than the one the
    // settings screen reports as primary.
    primary: guards.lane,
    catalog: selection.catalog,
    env: selection.env,
    // The primary lane's own observation, as the guards read it (issue #175's
    // per-lane keying): the wall this crossing is about is that lane's wall,
    // and a metered lane it might route onto reports no quota at all.
    observation: guards.quota,
    observations: selection.observations,
    pinnedLaneId: selection.pinnedLaneId,
    minLaneId: selection.minLaneId,
    tier: selection.tier,
    config: selection.config,
    overrides: selection.overrides,
    spentTodayUsd: selection.spentTodayUsd,
    confirmedAt: selection.confirmedAt,
    now,
  });
}
