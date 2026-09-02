/**
 * The money guards (issue #174): what may be spent through a **metered**
 * execution lane, and what has to happen before the first dollar of a day.
 *
 * The guards key off a resolved lane's **billing kind**, never off whether a
 * pass overflowed. That is the whole point of the ticket: the cheapest
 * configuration of this platform is not "subscription primary, metered
 * overflow" but metered-*primary* — drop the subscription and run the fleet
 * per-token — and a guard attached to the overflow transition would let that
 * configuration spend real money on every turn without confirmation, outside
 * any cap, and absent from the dashboard's split. A metered lane is a metered
 * lane whether it is primary, an overflow target (#173), or reached by
 * failover (#176).
 *
 * Two guards, one mechanism:
 *
 * - **Confirm once per local day, at fleet level.** The first metered spend of
 *   a day needs one human confirmation; everything after it that day proceeds
 *   automatically until the cap. Fleet level rather than per session, because
 *   nobody is sitting at the keyboard when an autonomous pass crosses into
 *   billing — the at-the-keyboard confirmation for interactive overflow is
 *   #173's, and a different thing.
 * - **A real-money daily cap.** Reaching it pauses new claims through the
 *   reducer's existing daily-cap pause, which is why this file computes state
 *   rather than actions: it is a second cap feeding one mechanism, not a
 *   second pause path.
 *
 * Pure, and deliberately so: every input arrives as a parameter — including
 * `now` — so both consumers (the autonomy reducer and the fleet read model)
 * evaluate the *same* function over the same facts and cannot disagree about
 * whether the fleet is held. Nothing here reads the settings row, the lane
 * file, the database or the clock.
 */

import type { AppConfig } from "../config";
import {
  resolveMeteredCapSetting,
  type SettingSource,
  type SettingsOverrides,
} from "../settings-resolver";
import type { LaneBilling } from "./lane-config";

/**
 * The real-money daily cap in force, and what set it.
 *
 * Two numbers bind it and the **lower wins**: the operator's dial (a settings
 * override, else the environment default) and the lane's own declared
 * `caps.daily_budget_usd`. Neither may widen the other — a lane file that says
 * "never more than $20/day on OpenRouter" is a reviewed, version-controlled
 * statement, and a settings press is not the place to overrule it; equally, a
 * lane declaring a generous cap must not raise a deployment that has dialled
 * its cash ceiling down. Which one binds is reported rather than inferred,
 * because "I set $50 and it stopped at $20" is exactly the surprise this whole
 * layer exists to make legible.
 */
export interface MeteredCap {
  /** The cap actually enforced (the lower of the two below). */
  capUsd: number;
  /** Which input is doing the binding. */
  boundBy: "settings" | "lane";
  /** The settings layer's value — an override, else the env default. */
  settingUsd: number;
  /** The lane's declared cap; null = the lane declares none. */
  laneUsd: number | null;
  /** Where the settings half came from (issue #166's provenance rule). */
  source: SettingSource;
  /** The stored override verbatim, or null when the field falls through. */
  override: string | null;
  envVar: string;
  /** The environment default, as a number — what clearing the override gives. */
  envUsd: number;
}

/**
 * Resolve the cap for one lane. `laneCapUsd` is that lane's declared
 * `caps.daily_budget_usd` (null when it declares none, which is the honest
 * state for a subscription lane, whose spend is notional).
 */
export function resolveMeteredCap(
  config: AppConfig,
  overrides: SettingsOverrides,
  laneCapUsd: number | null
): MeteredCap {
  const setting = resolveMeteredCapSetting(config, overrides);
  const bindsOnLane = laneCapUsd !== null && laneCapUsd < setting.usd;

  return {
    capUsd: bindsOnLane ? laneCapUsd : setting.usd,
    boundBy: bindsOnLane ? "lane" : "settings",
    settingUsd: setting.usd,
    laneUsd: laneCapUsd,
    source: setting.source,
    override: setting.override,
    envVar: setting.envVar,
    envUsd: setting.envUsd,
  };
}

/** Whether two instants fall on the same local calendar day — the reset the
 * confirmation answers to, matching the local midnight every other daily
 * figure here resets at. Written as a comparison rather than a third copy of
 * `startOfLocalDay`. */
export function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** What is holding metered work, when something is. The cap outranks the
 * confirmation: on a capped day confirming would start nothing, so naming the
 * confirmation would send the operator to press a control that cannot help. */
export type MeteredHold = "cap-reached" | "unconfirmed";

export interface MeteredSpendInput {
  /**
   * The billing kind of the lane work would run on. `null` = the lane could
   * not be resolved at all (an unreadable lane file, a primary naming no
   * declared lane), which is deliberately **not** a hold: such a fleet spends
   * nothing, because every pass fails as it starts with the reason named, and
   * inventing a money hold on top would only hide that.
   */
  billing: LaneBilling | null;
  /** Real money already spent through metered lanes today. */
  spentUsd: number;
  /** The cap in force — {@link resolveMeteredCap}'s `capUsd`. */
  capUsd: number;
  /** When the fleet last confirmed metered spend; null = never. */
  confirmedAt: Date | null;
  now: Date;
}

export interface MeteredSpendState {
  /** Whether the money guards apply at all. False on a subscription lane —
   * that work is quota, not cash, and the cap measures money. */
  metered: boolean;
  /** Confirmed for the local day containing `now`. */
  confirmed: boolean;
  capReached: boolean;
  /** What holds new autonomous pickup, or null when nothing does. */
  hold: MeteredHold | null;
  spentUsd: number;
  capUsd: number;
  /** Never negative: an overspent day reads as nothing left, not as a debt. */
  remainingUsd: number;
}

/**
 * The state of the money guards, for one moment and one lane. The reducer
 * turns a `hold` into a pause and an announcement; the dashboard renders the
 * same state as a banner and a gauge. Neither decides it for itself.
 */
export function evaluateMeteredSpend({
  billing,
  spentUsd,
  capUsd,
  confirmedAt,
  now,
}: MeteredSpendInput): MeteredSpendState {
  const metered = billing === "metered";
  const confirmed = confirmedAt !== null && sameLocalDay(confirmedAt, now);
  const capReached = spentUsd >= capUsd;
  return {
    metered,
    confirmed,
    capReached,
    hold: !metered ? null : capReached ? "cap-reached" : confirmed ? null : "unconfirmed",
    spentUsd,
    capUsd,
    remainingUsd: Math.max(0, capUsd - spentUsd),
  };
}
