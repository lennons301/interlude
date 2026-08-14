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

export interface FleetSettings {
  /** The global autonomy kill switch: engaged, no sweep claims new work */
  globalAutonomyPaused: boolean;
  /** When a setting was last written; null = never (the row doesn't exist yet) */
  updatedAt: Date | null;
}

const DEFAULTS: FleetSettings = {
  globalAutonomyPaused: false,
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
  if (!row) return DEFAULTS;
  return {
    globalAutonomyPaused: row.globalAutonomyPaused,
    updatedAt: row.updatedAt,
  };
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
  return { globalAutonomyPaused: paused, updatedAt: now };
}
