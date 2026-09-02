/**
 * The impure half of the crossing (issue #173): gather the facts
 * `decideLaneCrossing` judges, once, in one place.
 *
 * Three callers ask the same question from three different places — the turn
 * manager routing a pass onto a lane, the queue loop declining to start an
 * attended pass it cannot pay for, and the settings endpoint the task screen
 * asks so it can put the confirmation in front of the human. Asked three
 * times over three reads, they would eventually answer differently, and the
 * screen would offer a confirmation for a crossing the orchestrator was not
 * making.
 *
 * Built on `readMoneyGuards` rather than beside it, so "which lane, at what
 * cap, spent how much" keeps the single answer issue #174 gave it — this adds
 * only the quota telemetry and the pass kind.
 */

import { getConfig, type AgentPassKind } from "../config";
import { getQuotaObservation } from "../quota/quota-store";
import type { QuotaObservation } from "../quota/rate-limit-event";
import { getFleetSettings, type FleetSettings } from "../settings";
import { getLaneCatalog } from "./catalog";
import { readMoneyGuards } from "./money-state";
import { decideLaneCrossing, type LaneCrossing } from "./overflow";

/**
 * The crossing for one pass kind, as the fleet stands right now.
 *
 * Everything is read fresh — the settings row (which carries the cap and the
 * confirmation), the quota row (which carries the wall) and the day's cash —
 * so a confirmation pressed on the screen reaches the next poll rather than
 * the next restart. The lane *file* is the one cached read, because it cannot
 * change without a deploy.
 */
export function readLaneCrossing(
  kind: AgentPassKind,
  now: Date = new Date(),
  settings: FleetSettings = getFleetSettings(),
  observation: QuotaObservation | null = getQuotaObservation()
): LaneCrossing {
  const catalog = getLaneCatalog();
  // Read for its facts — which lane is in force, and what the card has been
  // charged today — rather than for its verdict: the guards judge the *primary*
  // lane, and a crossing may be about a different one, whose own declared cap
  // binds. `decideLaneCrossing` therefore re-evaluates #174's own functions for
  // the lane it picks, which is the same pair of pure calls, not a second
  // policy.
  const guards = readMoneyGuards(now, settings, observation);

  return decideLaneCrossing({
    kind,
    // The lane in force, from the same read the dashboard and the sweep make,
    // so this can never route a pass onto a lane other than the one the
    // settings screen reports as primary.
    primary: guards.lane,
    catalog: catalog.ok ? catalog.catalog : null,
    // Availability only. No secret's *value* leaves this call: the crossing
    // decides which lane, and `resolveLane` is still the only reader of a
    // credential.
    env: process.env,
    observation,
    config: getConfig(),
    overrides: settings.overrides,
    spentTodayUsd: guards.spentTodayUsd,
    confirmedAt: settings.meteredSpendConfirmedAt,
    now,
  });
}
