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
  isGlobalAutonomyPaused,
  setGlobalAutonomyPaused,
} from "../settings";
import { settings } from "@/db/schema";

const NOW = new Date(2026, 7, 1, 12, 0, 0);

describe("fleet settings — the global autonomy kill switch", () => {
  beforeEach(() => {
    testDb = createTestDb().db;
  });

  it("defaults to not paused on an install that has never written a setting", () => {
    expect(getFleetSettings()).toEqual({
      globalAutonomyPaused: false,
      updatedAt: null,
    });
    expect(isGlobalAutonomyPaused()).toBe(false);
  });

  it("engages the switch and reads it back", () => {
    expect(setGlobalAutonomyPaused(true, NOW)).toEqual({
      globalAutonomyPaused: true,
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
