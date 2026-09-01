import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb } from "@/test/create-test-db";

// The durable settings row (issue #118), run against a from-migrations DB —
// the kill switch has to survive a restart, so its persistence is the contract.
let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

import {
  getFleetSettings,
  getSettingsOverrides,
  isGlobalAutonomyPaused,
  setGlobalAutonomyPaused,
  updateSettingsOverrides,
} from "../settings";
import { SETTINGS_ROW_ID, settings } from "@/db/schema";

const NOW = new Date(2026, 7, 1, 12, 0, 0);

describe("fleet settings — the global autonomy kill switch", () => {
  beforeEach(() => {
    testDb = createTestDb().db;
  });

  it("defaults to not paused on an install that has never written a setting", () => {
    expect(getFleetSettings()).toEqual({
      globalAutonomyPaused: false,
      overrides: {},
      updatedAt: null,
    });
    expect(isGlobalAutonomyPaused()).toBe(false);
  });

  it("engages the switch and reads it back", () => {
    expect(setGlobalAutonomyPaused(true, NOW)).toEqual({
      globalAutonomyPaused: true,
      overrides: {},
      updatedAt: NOW,
    });

    expect(isGlobalAutonomyPaused()).toBe(true);
    expect(getFleetSettings().updatedAt).toEqual(NOW);
  });

  it("lifts the switch again, stamping the new write", () => {
    setGlobalAutonomyPaused(true, NOW);
    const later = new Date(NOW.getTime() + 60_000);

    setGlobalAutonomyPaused(false, later);

    expect(getFleetSettings()).toEqual({
      globalAutonomyPaused: false,
      overrides: {},
      updatedAt: later,
    });
  });

  it("keeps exactly one row however often it is written", () => {
    setGlobalAutonomyPaused(true, NOW);
    setGlobalAutonomyPaused(false, NOW);
    setGlobalAutonomyPaused(true, NOW);

    expect(testDb.select().from(settings).all()).toHaveLength(1);
  });
});

/**
 * The override layer on the same row (issue #166). The persistence contract is
 * what makes "takes effect at the next sweep, with no restart" true: a change
 * is a row write, and every read goes back to the row.
 */
describe("fleet settings — UI overrides of env config", () => {
  beforeEach(() => {
    testDb = createTestDb().db;
  });

  it("reads no overrides on an install that has never set one", () => {
    expect(getSettingsOverrides()).toEqual({});
  });

  it("stores an override and reads it straight back", () => {
    expect(updateSettingsOverrides({ modelTierReview: "light" }, NOW)).toEqual({
      globalAutonomyPaused: false,
      overrides: { modelTierReview: "light" },
      updatedAt: NOW,
    });
    expect(getSettingsOverrides()).toEqual({ modelTierReview: "light" });
  });

  it("clears one override without disturbing the others", () => {
    updateSettingsOverrides(
      { modelTierReview: "light", modelTierTriage: "light" },
      NOW
    );

    updateSettingsOverrides({ modelTierReview: null }, NOW);

    expect(getSettingsOverrides()).toEqual({ modelTierTriage: "light" });
  });

  it("leaves the kill switch alone when an override is written, and vice versa", () => {
    setGlobalAutonomyPaused(true, NOW);
    updateSettingsOverrides({ modelTierTriage: "light" }, NOW);
    expect(getFleetSettings()).toEqual({
      globalAutonomyPaused: true,
      overrides: { modelTierTriage: "light" },
      updatedAt: NOW,
    });

    setGlobalAutonomyPaused(false, NOW);
    expect(getSettingsOverrides()).toEqual({ modelTierTriage: "light" });
  });

  it("keeps exactly one row, and survives being read as a fresh process would", () => {
    updateSettingsOverrides({ modelTierImplement: "standard" }, NOW);
    updateSettingsOverrides({ modelTierImplement: "heavy" }, NOW);

    expect(testDb.select().from(settings).all()).toHaveLength(1);
    // Straight off the row, decoded by the resolver's defensive read.
    expect(getSettingsOverrides()).toEqual({ modelTierImplement: "heavy" });
  });

  it("falls through when the stored JSON names something no longer settable", () => {
    // Written by an older build: a key this version has retired.
    testDb
      .insert(settings)
      .values({
        id: SETTINGS_ROW_ID,
        overrides: { modelTierGone: "heavy" } as never,
        updatedAt: NOW,
      })
      .run();

    expect(getSettingsOverrides()).toEqual({});
  });
});
