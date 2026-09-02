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
  planLaneFailover,
  selectLane,
  type LaneFailoverOption,
  type LaneSelection,
  type LaneSelectionInput,
} from "./lane-selection";
import { readMoneyGuards } from "./money-state";
import { decideLaneCrossing, type LaneCrossing } from "./overflow";

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
  settings: FleetSettings
): LaneSelectionInput {
  const config = getConfig();
  const catalog = getLaneCatalog();
  // Read for its facts — which lane is in force, whether that choice pins the
  // fleet, and what the card has been charged today — rather than for its
  // verdict: the guards judge the *primary* lane, and routing may be about a
  // different one, whose own declared cap binds. The ranking therefore
  // re-evaluates #174's own functions per lane, which is the same pair of pure
  // calls, not a second policy.
  const guards = readMoneyGuards(now, settings);

  return {
    catalog: catalog.ok ? catalog.catalog : null,
    // Availability only. No secret's *value* leaves this call: routing decides
    // which lane, and `resolveLane` is still the only reader of a credential.
    env: process.env,
    kind,
    tier: resolveAgentModelChoice(kind, config, ticketModel, settings.overrides)
      .tier,
    // An operator's explicit choice pins the fleet and turns the ranking off
    // (issue #172's own distinction, not a new setting).
    pinnedLaneId: guards.pinnedLaneId,
    minLaneId: resolveMinLane(kind, config, settings.overrides).laneId,
    // Every lane's window, because whether a lane can serve a request is a
    // fact about that lane (issue #175's per-lane keying). A lane with no row
    // is absent here, which the ranking reads as "no observation" — never as a
    // closed door, since a metered provider reports none at all.
    observations: getQuotaObservations(),
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
  return selectLane(laneSelectionInput(kind, ticketModel, now, settings));
}

/**
 * Where a pass its lane's quota window has refused may move to instead of
 * pausing (issue #176), or null when there is nowhere both available and
 * permitted — in which case #168's pause is what happens, exactly as before.
 *
 * The same ranking `readLaneSelection` reads, with the refused lane excluded:
 * "which lane should this pass run on?" is one question, and asking it a
 * second way after a wall is how the routing and the failover would come to
 * disagree about which lane is cheapest.
 */
export function readLaneFailover(
  kind: AgentPassKind,
  ticketModel: string | null,
  fromLaneId: string | null,
  now: Date = new Date(),
  settings: FleetSettings = getFleetSettings()
): LaneFailoverOption | null {
  return planLaneFailover({
    ...laneSelectionInput(kind, ticketModel, now, settings),
    fromLaneId,
  });
}

/**
 * The crossing for one pass kind, as the fleet stands right now.
 *
 * Everything is read fresh — the settings row (which carries the cap, the
 * confirmation and the floors), every lane's quota row (which carries the
 * walls) and the day's cash — so a confirmation pressed on the screen reaches
 * the next poll rather than the next restart. The lane *file* is the one cached
 * read, because it cannot change without a deploy.
 */
export function readLaneCrossing(
  kind: AgentPassKind,
  ticketModel: string | null = null,
  now: Date = new Date(),
  settings: FleetSettings = getFleetSettings()
): LaneCrossing {
  const selection = laneSelectionInput(kind, ticketModel, now, settings);
  const guards = readMoneyGuards(now, settings);

  return decideLaneCrossing({
    kind,
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
