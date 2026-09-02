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
    // the environment rather than reaching the CLI.
    //
    // Deliberately *without* the lane catalog (issue #172), unlike the write
    // path. Sanitising a stored `primaryLane` against the catalog here would
    // erase an operator's choice the moment a deploy renamed the lane — the
    // screen would show the choice as never made, and the next PATCH of any
    // other field would write the erasure back to the row permanently. The
    // resolver already handles a dangling id safely *and* visibly: it falls
    // through to the file's preference order and reports the id as
    // `unknownChoice`, which the lane panel shows. Rejecting an undeclared
    // lane by name is the write path's job, where the operator is there to be
    // told.
    overrides: sanitizeOverrides(row.overrides),
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
