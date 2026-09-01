import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/test/create-test-db";
import { QUOTA_STATE_ROW_ID, quotaState } from "@/db/schema";
import type { QuotaObservation } from "../rate-limit-event";

/**
 * The durable half (issue #167): one row, latest observation wins, and a read
 * that cannot throw whatever is in the column.
 */

let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const { recordQuotaObservation, getQuotaObservation } = await import(
  "../quota-store"
);

beforeEach(() => {
  testDb = createTestDb().db;
});

function observation(overrides: Partial<QuotaObservation> = {}): QuotaObservation {
  return {
    status: "allowed_warning",
    rateLimitType: "seven_day",
    utilization: 91,
    resetsAt: new Date("2026-09-05T00:00:00.000Z"),
    overageStatus: "allowed",
    overageResetsAt: null,
    isUsingOverage: false,
    overageInUse: true,
    observedAt: new Date("2026-09-01T12:00:00.000Z"),
    ...overrides,
  };
}

describe("quota state", () => {
  it("reads as null before anything has been observed", () => {
    // Not an error state: it is also where a fleet on API-key auth stays
    // forever, since the unified-window machinery is subscription-only.
    expect(getQuotaObservation()).toBeNull();
  });

  it("round-trips an observation, dates and all", () => {
    const observed = observation();
    recordQuotaObservation(observed);
    expect(getQuotaObservation()).toEqual(observed);
  });

  it("keeps the latest observation, in one row", () => {
    recordQuotaObservation(observation());
    recordQuotaObservation(
      observation({
        status: "rejected",
        rateLimitType: "five_hour",
        utilization: null,
        observedAt: new Date("2026-09-01T13:00:00.000Z"),
      })
    );

    expect(testDb.select().from(quotaState).all()).toHaveLength(1);
    expect(getQuotaObservation()).toMatchObject({
      status: "rejected",
      rateLimitType: "five_hour",
      utilization: null,
      observedAt: new Date("2026-09-01T13:00:00.000Z"),
    });
  });

  it("keeps an absent utilization absent across the round trip", () => {
    // The field the whole record exists to be honest about: null must not come
    // back as 0 through a JSON column.
    recordQuotaObservation(observation({ utilization: null, resetsAt: null }));
    const read = getQuotaObservation();
    expect(read?.utilization).toBeNull();
    expect(read?.resetsAt).toBeNull();
  });

  it("reads a row written by some other build as null rather than throwing", () => {
    // The column is JSON written by an app, not a contract with a server; a
    // shape this build cannot read must cost the dashboard a tile, not a crash.
    testDb
      .insert(quotaState)
      .values({
        id: QUOTA_STATE_ROW_ID,
        observation: { retired: "shape" },
        observedAt: new Date("2026-09-01T12:00:00.000Z"),
      })
      .run();

    expect(getQuotaObservation()).toBeNull();
  });

  it("never lets a failed write reach the turn it was observed in", () => {
    // This runs on the stream-parse path of every turn the fleet runs.
    const broken = {
      insert: () => {
        throw new Error("database is locked");
      },
    };
    testDb = broken as unknown as typeof testDb;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => recordQuotaObservation(observation())).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
