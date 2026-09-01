/**
 * Durable fleet-wide operator settings (issue #118) — the runtime half of this
 * app's configuration. Env config (`config.ts`) is fixed when the process boots;
 * what lives here is flipped by a human while the fleet runs and is read fresh
 * at the point of use, so a change takes effect without a restart.
 *
 * Exactly one row backs all of it (`SETTINGS_ROW_ID`), written on demand: an
 * install that has never touched a setting reads the same defaults as a fresh
 * one, so there is no boot-time seeding step to forget.
 */

import { db } from "@/db";
import { SETTINGS_ROW_ID, settings } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  applySettingsPatch,
  sanitizeOverrides,
  type SettingsOverrides,
  type SettingsPatch,
} from "./settings-resolver";
import { laneCatalogContext } from "./lanes/settings-context";

export interface FleetSettings {
  /** The global autonomy kill switch: engaged, no sweep claims new work */
  globalAutonomyPaused: boolean;
  /** Env-config overrides set from the UI (issue #166). A field absent here
   * falls through to the environment default — see `settings-resolver.ts`,
   * which owns the allowlist, the validation and the merge. */
  overrides: SettingsOverrides;
  /** When a setting was last written; null = never (the row doesn't exist yet) */
  updatedAt: Date | null;
}

const DEFAULTS: FleetSettings = {
  globalAutonomyPaused: false,
  overrides: {},
  updatedAt: null,
};

/** The current settings, straight from the row — never cached, so the autonomy
 * sweep and the dashboard both see a flip on their next read. */
export function getFleetSettings(): FleetSettings {
  const row = db
    .select()
    .from(settings)
    .where(eq(settings.id, SETTINGS_ROW_ID))
    .get();
  if (!row) return { ...DEFAULTS };
  return {
    globalAutonomyPaused: row.globalAutonomyPaused,
    // Defensive: the column is JSON an older build wrote, so a retired key or
    // a value a since-narrowed vocabulary no longer accepts falls through to
    // the environment rather than reaching the CLI. The lane catalog is passed
    // so a stored lane id that a deploy has since removed from `lanes.yaml`
    // falls through to the file's own preference order (issue #172) rather
    // than pinning the fleet to a lane that no longer exists.
    overrides: sanitizeOverrides(row.overrides, laneCatalogContext()),
    updatedAt: row.updatedAt,
  };
}

/**
 * The overrides in force, straight from the row. Deliberately a fresh read on
 * every call, for the same reason the kill switch is: `getConfig()` memoises
 * into a module-level value on first read, so a UI override cannot ride on it
 * — the effective settings have to be re-read at the point of use for a change
 * to take effect at the next sweep rather than at the next restart.
 */
export function getSettingsOverrides(): SettingsOverrides {
  return getFleetSettings().overrides;
}

/**
 * Whether the global kill switch is engaged. Deliberately a fresh read on every
 * call: the sweep asks once per tick, which is what makes "stop the fleet" take
 * effect at the next tick rather than at the next restart.
 */
export function isGlobalAutonomyPaused(): boolean {
  return getFleetSettings().globalAutonomyPaused;
}

/** Engage or lift the global kill switch. Upserts the single row, so the first
 * write on a long-lived install creates it. */
export function setGlobalAutonomyPaused(
  paused: boolean,
  now: Date = new Date()
): FleetSettings {
  db.insert(settings)
    .values({
      id: SETTINGS_ROW_ID,
      globalAutonomyPaused: paused,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: settings.id,
      set: { globalAutonomyPaused: paused, updatedAt: now },
    })
    .run();
  return getFleetSettings();
}

/**
 * Apply a validated patch to the stored overrides and return the whole
 * settings state. A patch value of null clears the field back to its
 * environment default; the merge itself is the resolver's pure
 * `applySettingsPatch`, so what is stored is what the resolver would compute.
 *
 * Upserts the single row like the kill switch does, so the first override on a
 * long-lived install creates it.
 */
export function updateSettingsOverrides(
  patch: SettingsPatch,
  now: Date = new Date()
): FleetSettings {
  const next = applySettingsPatch(getSettingsOverrides(), patch);
  db.insert(settings)
    .values({ id: SETTINGS_ROW_ID, overrides: next, updatedAt: now })
    .onConflictDoUpdate({
      target: settings.id,
      set: { overrides: next, updatedAt: now },
    })
    .run();
  return getFleetSettings();
}
