import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/test/create-test-db";
import { quotaState } from "@/db/schema";
import type { QuotaObservation } from "../rate-limit-event";

/**
 * The durable half (issue #167): one row **per lane** since #175, latest
 * observation wins, and a read that cannot throw whatever is in the column.
 *
 * Run against the real checked-in `lanes.yaml`, deliberately, for the same
 * reason `per-lane-gate.test.ts` does: the credential-fingerprint check
 * (issue #251) reads each lane's real `auth` entries, and a fixture catalog
 * would pass while the shipped file named a lane with a different variable.
 */

const SUBSCRIPTION = "claude-subscription";
const ANTHROPIC_API = "anthropic-api";

let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const { recordQuotaObservation, getQuotaObservation, getQuotaObservations } =
  await import("../quota-store");
const { resetLaneCatalog } = await import("@/lib/lanes/catalog");

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  testDb = createTestDb().db;
  // A credential on every lane these tests touch, so an observation recorded
  // and then read back in the same test — the ordinary case every test but
  // the rotation ones exercises — sees a stable fingerprint throughout.
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test-account";
  process.env.ANTHROPIC_API_KEY = "sk-ant-api-test-key";
  resetLaneCatalog();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetLaneCatalog();
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
    expect(getQuotaObservation(SUBSCRIPTION)).toBeNull();
  });

  it("round-trips an observation, dates and all", () => {
    const observed = observation();
    recordQuotaObservation(SUBSCRIPTION, observed);
    expect(getQuotaObservation(SUBSCRIPTION)).toEqual(observed);
  });

  it("never lets one lane's observation answer for another", () => {
    // The invariant issue #175 exists for: OpenRouter emits no rate-limit
    // telemetry at all, so a metered lane's quota is null forever. Under one
    // fleet-wide row the subscription's last reading would stand in for it,
    // and a lane bounded by spend would be gated by somebody else's wall.
    recordQuotaObservation(SUBSCRIPTION, observation({ status: "rejected" }));

    expect(getQuotaObservation("openrouter-glm")).toBeNull();
    expect(getQuotaObservation(SUBSCRIPTION)?.status).toBe("rejected");
  });

  it("keeps a row per lane, each one latest-wins on its own", () => {
    recordQuotaObservation(SUBSCRIPTION, observation({ status: "allowed" }));
    recordQuotaObservation("anthropic-api", observation({ status: "rejected" }));

    expect(testDb.select().from(quotaState).all()).toHaveLength(2);
    expect(getQuotaObservation(SUBSCRIPTION)?.status).toBe("allowed");
    expect(getQuotaObservation("anthropic-api")?.status).toBe("rejected");
  });

  it("reads no lane at all as no quota", () => {
    // An unusable lanes.yaml resolves no primary lane; there is then no
    // account whose quota this could be.
    recordQuotaObservation(SUBSCRIPTION, observation());
    expect(getQuotaObservation(null)).toBeNull();
  });

  it("keeps the latest observation, in one row", () => {
    recordQuotaObservation(SUBSCRIPTION, observation());
    recordQuotaObservation(
      SUBSCRIPTION,
      observation({
        status: "rejected",
        rateLimitType: "five_hour",
        utilization: null,
        observedAt: new Date("2026-09-01T13:00:00.000Z"),
      })
    );

    expect(testDb.select().from(quotaState).all()).toHaveLength(1);
    expect(getQuotaObservation(SUBSCRIPTION)).toMatchObject({
      status: "rejected",
      rateLimitType: "five_hour",
      utilization: null,
      observedAt: new Date("2026-09-01T13:00:00.000Z"),
    });
  });

  it("stores the row in the wire's own encoding, so one reader serves both", () => {
    // Why this matters beyond tidiness: the column is read back through
    // `parseRateLimitEvent`, the same function the stream goes through, so
    // there is no second defensive reader to fall out of step with the first.
    recordQuotaObservation(SUBSCRIPTION, observation());
    const row = testDb.select().from(quotaState).get()!;

    expect(row.observation).toMatchObject({
      status: "allowed_warning",
      rateLimitType: "seven_day",
      // Unix seconds, as the CLI sends them — not an ISO string.
      resetsAt: Math.floor(Date.parse("2026-09-05T00:00:00.000Z") / 1000),
    });
  });

  it("keeps an absent utilization absent across the round trip", () => {
    // The field the whole record exists to be honest about: null must not come
    // back as 0 through a JSON column.
    recordQuotaObservation(
      SUBSCRIPTION,
      observation({ utilization: null, resetsAt: null })
    );
    const read = getQuotaObservation(SUBSCRIPTION);
    expect(read?.utilization).toBeNull();
    expect(read?.resetsAt).toBeNull();
  });

  it("reads a row written by some other build as null rather than throwing", () => {
    // The column is JSON written by an app, not a contract with a server; a
    // shape this build cannot read must cost the dashboard a tile, not a crash.
    testDb
      .insert(quotaState)
      .values({
        lane: SUBSCRIPTION,
        observation: { retired: "shape" },
        observedAt: new Date("2026-09-01T12:00:00.000Z"),
      })
      .run();

    expect(getQuotaObservation(SUBSCRIPTION)).toBeNull();
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

    expect(() =>
      recordQuotaObservation(SUBSCRIPTION, observation())
    ).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  describe("a rotated credential (issue #251)", () => {
    // The incident this guards: a lane's credential is repointed at a
    // different account — including, as happened on 2026-09-20, across plan
    // tiers with unrelated reset schedules — and the *old* account's
    // rejection must stop describing the new one immediately, not wait out a
    // `resetsAt` that was never about it.

    it("survives an unchanged credential across a restart", () => {
      recordQuotaObservation(SUBSCRIPTION, observation({ status: "rejected" }));
      // A restart re-reads the same env into a fresh process; nothing about
      // the credential changed, so the fingerprint recomputes identically.
      resetLaneCatalog();

      expect(getQuotaObservation(SUBSCRIPTION)?.status).toBe("rejected");
    });

    it("reads a rejection as unobserved once the lane's credential changes", () => {
      recordQuotaObservation(
        SUBSCRIPTION,
        observation({
          status: "rejected",
          // A wall dated weeks out, as an Enterprise seat's monthly reset
          // would be — the exact shape that made the live incident wedge
          // rather than merely delay.
          resetsAt: new Date("2026-10-01T00:00:00.000Z"),
        })
      );

      process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-a-different-account";

      expect(getQuotaObservation(SUBSCRIPTION)).toBeNull();
    });

    it("does not let one lane's rotation affect another's observation", () => {
      recordQuotaObservation(SUBSCRIPTION, observation({ status: "rejected" }));
      recordQuotaObservation(ANTHROPIC_API, observation({ status: "allowed" }));

      process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-rotated";

      expect(getQuotaObservation(SUBSCRIPTION)).toBeNull();
      expect(getQuotaObservation(ANTHROPIC_API)?.status).toBe("allowed");
    });

    it("drops a rotated lane from getQuotaObservations() but keeps the rest", () => {
      recordQuotaObservation(SUBSCRIPTION, observation({ status: "rejected" }));
      recordQuotaObservation(ANTHROPIC_API, observation({ status: "allowed" }));

      process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-rotated";

      const all = getQuotaObservations();
      expect(all[SUBSCRIPTION]).toBeUndefined();
      expect(all[ANTHROPIC_API]?.status).toBe("allowed");
    });

    it("treats a pre-migration row (no stored fingerprint) as unobserved rather than trusting it forever", () => {
      // A row written before this column existed reads back with a null
      // `credentialFingerprint`. Trusting that indefinitely would mean this
      // fix protects nothing on the deploy that most needs it — the very
      // rows already gating the fleet when it ships.
      testDb
        .insert(quotaState)
        .values({
          lane: SUBSCRIPTION,
          observation: {
            status: "rejected",
            rateLimitType: null,
            utilization: null,
            resetsAt: Math.floor(Date.parse("2026-10-01T00:00:00.000Z") / 1000),
            overageStatus: null,
            overageResetsAt: null,
            isUsingOverage: false,
            overageInUse: null,
          },
          observedAt: new Date("2026-09-20T07:22:00.000Z"),
          // credentialFingerprint intentionally omitted — a legacy row.
        })
        .run();

      expect(getQuotaObservation(SUBSCRIPTION)).toBeNull();
    });

    it("records a fresh, unrejected observation once the new credential is actually exercised", () => {
      // The self-healing path: the incident's real fix. A rejected
      // observation under the old credential is superseded the moment the
      // fleet makes one real call on the new one.
      recordQuotaObservation(SUBSCRIPTION, observation({ status: "rejected" }));
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-new-account";
      expect(getQuotaObservation(SUBSCRIPTION)).toBeNull();

      recordQuotaObservation(SUBSCRIPTION, observation({ status: "allowed" }));
      expect(getQuotaObservation(SUBSCRIPTION)?.status).toBe("allowed");
    });
  });
});
