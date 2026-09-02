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
  setMeteredSpendConfirmed,
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
      meteredSpendConfirmedAt: null,
      overrides: {},
      updatedAt: null,
    });
    expect(isGlobalAutonomyPaused()).toBe(false);
  });

  it("engages the switch and reads it back", () => {
    expect(setGlobalAutonomyPaused(true, NOW)).toEqual({
      globalAutonomyPaused: true,
      meteredSpendConfirmedAt: null,
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
      meteredSpendConfirmedAt: null,
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
      meteredSpendConfirmedAt: null,
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
      meteredSpendConfirmedAt: null,
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

/**
 * The confirm-once-per-day gate's durable half (issue #174). A restart must
 * not re-ask — a fleet held for a confirmation it already has is a wedge —
 * and must not silently forget that nobody ever confirmed.
 */
describe("fleet settings — the real-money spend confirmation", () => {
  beforeEach(() => {
    testDb = createTestDb().db;
  });

  it("is unconfirmed on an install that has never been asked", () => {
    expect(getFleetSettings().meteredSpendConfirmedAt).toBeNull();
  });

  it("records when it was confirmed, and reads back across a fresh read", () => {
    expect(setMeteredSpendConfirmed(true, NOW).meteredSpendConfirmedAt).toEqual(NOW);
    expect(getFleetSettings().meteredSpendConfirmedAt).toEqual(NOW);
  });

  it("withdraws to null rather than to an older stamp", () => {
    setMeteredSpendConfirmed(true, NOW);

    setMeteredSpendConfirmed(false, new Date(NOW.getTime() + 60_000));

    // "Confirmed, for a day that has passed" and "never confirmed" are the
    // same state to every reader; keeping a stale stamp would invite one to
    // treat it as evidence.
    expect(getFleetSettings().meteredSpendConfirmedAt).toBeNull();
  });

  it("leaves the kill switch and the overrides alone", () => {
    setGlobalAutonomyPaused(true, NOW);
    updateSettingsOverrides({ modelTierTriage: "light" }, NOW);

    setMeteredSpendConfirmed(true, NOW);

    expect(getFleetSettings()).toEqual({
      globalAutonomyPaused: true,
      meteredSpendConfirmedAt: NOW,
      overrides: { modelTierTriage: "light" },
      updatedAt: NOW,
    });
    expect(testDb.select().from(settings).all()).toHaveLength(1);
  });
});
