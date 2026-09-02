/**
 * The impure half of the money guards (issue #174): gather the facts the pure
 * `money.ts` judges, once, in one place.
 *
 * Three callers need exactly the same four things — which lane is in force, who
 * pays for it, what the cash cap is, and how much has gone through it today:
 * the autonomy sweep (to build its snapshot), the fleet read model (to render
 * the tile) and the settings endpoint (to answer the panel). Written out three
 * times, "which lane, at what cap" would eventually have three answers, and the
 * screen would report a fleet other than the one the sweep is gating — the
 * exact failure the lane work exists to prevent.
 *
 * Everything is read fresh: the settings row is handed in by the caller (which
 * has usually just read it for the kill switch, and the two must describe the
 * same instant), and the lane catalog is the checked-in file, which cannot
 * change without a deploy. That is what makes switching the primary lane
 * between billing kinds take effect at the next sweep with no restart.
 */

import { getConfig } from "../config";
import { todayMeteredSpendUsd } from "../orchestrator/spend";
import type { QuotaObservation } from "../quota/rate-limit-event";
import type { FleetSettings } from "../settings";
import { getLaneCatalog } from "./catalog";
import type { LaneBilling } from "./lane-config";
import {
  effectiveBilling,
  overageIsThePayer,
  overagePaysNow,
} from "./overflow";
import {
  evaluateMeteredSpend,
  resolveMeteredCap,
  type MeteredCap,
  type MeteredSpendState,
} from "./money";
import { primaryLaneOf, type LaneView } from "./resolve";

export interface MoneyGuards {
  /** The lane work would run on; null = none resolves. */
  lane: LaneView | null;
  /**
   * How that lane must be billed *now* (issue #173) — its declared kind, or
   * `metered` when an active overage means the account is already paying cash
   * for subscription work. This, not `lane.billing`, is what the guards key
   * off: an account with overage billing enabled would otherwise never show a
   * `rejected` at all, and the wall would silently become a bill.
   */
  billing: LaneBilling | null;
  /**
   * Whether an **overage** is what is being billed, rather than the lane
   * itself — the predicate every surface that writes a sentence about it
   * reads, so none of them can accuse a subscription lane of billing per
   * token, or describe a metered lane as an overage.
   */
  overagePaying: boolean;
  /** Why the lane file could not be read, when it could not be. */
  laneError: string | null;
  cap: MeteredCap;
  /** Real money spent on the local day containing `now`. */
  spentTodayUsd: number;
  /** What the guards make of all that — the same evaluation the reducer and
   * the dashboard each run, so no caller decides it a second time. */
  state: MeteredSpendState;
}

export function readMoneyGuards(
  now: Date,
  settings: FleetSettings,
  /** The fleet's last quota observation (issue #167). Handed in rather than
   * read here because both impure callers have just read it for the admission
   * gate, and the two must describe the same instant. */
  observation: QuotaObservation | null
): MoneyGuards {
  const config = getConfig();
  const catalog = getLaneCatalog();
  const lane = catalog.ok
    ? primaryLaneOf({
        catalog: catalog.catalog,
        config,
        overrides: settings.overrides,
        env: process.env,
      })
    : null;
  const cap = resolveMeteredCap(
    config,
    settings.overrides,
    lane?.caps.dailyBudgetUsd ?? null
  );
  const spentTodayUsd = todayMeteredSpendUsd(now);
  const overage = overagePaysNow(observation, now);
  const billing =
    lane === null ? null : effectiveBilling(lane.billing, overage);
  const overagePaying = overageIsThePayer(lane?.billing ?? null, overage);

  return {
    lane,
    billing,
    overagePaying,
    laneError: catalog.ok ? null : catalog.reason,
    cap,
    spentTodayUsd,
    state: evaluateMeteredSpend({
      // Null billing — an unreadable lane file, or a choice naming no declared
      // lane — decides nothing either way: such a fleet spends nothing, since
      // every pass refuses to start with the reason named.
      billing,
      spentUsd: spentTodayUsd,
      capUsd: cap.capUsd,
      confirmedAt: settings.meteredSpendConfirmedAt,
      now,
    }),
  };
}
