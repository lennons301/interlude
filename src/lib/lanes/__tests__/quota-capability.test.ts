import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/test/create-test-db";
import { parseLaneConfig, type LaneCatalog } from "../lane-config";
import { actionableObservations } from "../lane-wall";
import { evaluateQuotaGate } from "@/lib/quota/quota-gate";
import type { QuotaObservation } from "@/lib/quota/rate-limit-event";
import {
  DESCRIPTORS_WITH_FAKE,
  FAKE_HARNESS_ID,
  FAKE_LANE_AUTH_VAR,
} from "@/test/fake-harness";

/**
 * The fleet acts on no quota observation from a lane whose **harness** declares
 * no quota telemetry (issue #219) — the admission gate never holds on one, the
 * ranking never calls such a lane walled, and the dashboard's tile reads
 * "cannot report" rather than a stale row.
 *
 * Two pieces make that true, and both are tested through the one impure read
 * every surface shares (`readMoneyGuards`, and the ranking input built on it):
 * the primary lane's row is read only where its harness reports quota, and
 * the ranking's map of every lane's row is filtered the same way. The row
 * itself is left alone — the fake adapter has `quotaTelemetry: false`, and the
 * observation recorded under its lane below stands in for a row a deploy left
 * behind when it moved the id onto another adapter, or one an adapter wrote in
 * breach of its own descriptor.
 */

let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

// Two lanes, one on each kind of harness, in place of `lanes.yaml`: the fake
// (no quota telemetry) first in preference so it is the lane in force.
const SILENT_LANE_ID = "silent-lane";
const CLAUDE_LANE_ID = "claude-lane";
const CATALOG_YAML = `
primary:
  - ${SILENT_LANE_ID}
  - ${CLAUDE_LANE_ID}
lanes:
  - id: ${SILENT_LANE_ID}
    label: Silent harness
    adapter: ${FAKE_HARNESS_ID}
    billing: subscription
    auth:
      ${FAKE_LANE_AUTH_VAR}: ${FAKE_LANE_AUTH_VAR}
    models:
      heavy: fake-heavy
      standard: fake-standard
      light: fake-light
  - id: ${CLAUDE_LANE_ID}
    label: Claude subscription
    adapter: claude-code
    billing: subscription
    auth:
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_CODE_OAUTH_TOKEN
    models:
      heavy: opus
      standard: sonnet
      light: haiku
`;

function catalog(): LaneCatalog {
  const parsed = parseLaneConfig(CATALOG_YAML, DESCRIPTORS_WITH_FAKE);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.catalog;
}

vi.mock("../catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../catalog")>();
  return {
    ...actual,
    getLaneCatalog: () => ({ ok: true, catalog: catalog() }),
  };
});

const { recordQuotaObservation, getQuotaObservation } = await import(
  "@/lib/quota/quota-store"
);
const { readMoneyGuards } = await import("../money-state");
const { readLaneSelection } = await import("../overflow-state");
const { getFleetSettings } = await import("@/lib/settings");
const { resetConfig } = await import("@/lib/config");

const NOW = new Date("2026-09-05T12:00:00.000Z");

/** A live wall: rejected, with hours to run. */
const REJECTED: QuotaObservation = {
  status: "rejected",
  rateLimitType: "five_hour",
  utilization: 100,
  resetsAt: new Date("2026-09-05T16:00:00.000Z"),
  overageStatus: null,
  overageResetsAt: null,
  isUsingOverage: false,
  overageInUse: null,
  observedAt: new Date("2026-09-05T11:59:00.000Z"),
};

beforeEach(() => {
  testDb = createTestDb().db;
  process.env[FAKE_LANE_AUTH_VAR] = "fake-token";
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test";
  delete process.env.AGENT_LANE;
  delete process.env.AGENT_MIN_LANE;
  resetConfig();
});

describe("quota telemetry follows the harness's declared capability (issue #219)", () => {
  it("does not read the primary lane's row when its harness reports no quota", () => {
    // The row exists — and the read returns null anyway, so the gate stays
    // open and the tile says "cannot report" rather than showing a wall no
    // such harness could have observed.
    recordQuotaObservation(SILENT_LANE_ID, REJECTED);
    expect(getQuotaObservation(SILENT_LANE_ID)?.status).toBe("rejected");

    const guards = readMoneyGuards(NOW, getFleetSettings());

    expect(guards.lane?.id).toBe(SILENT_LANE_ID);
    expect(guards.lane?.capabilities.quotaTelemetry).toBe(false);
    expect(guards.quota).toBeNull();
    expect(evaluateQuotaGate(guards.quota, 90, NOW).closed).toBe(false);
    // And the row said nothing about an overage either.
    expect(guards.billing).toBe("subscription");
    expect(guards.overagePaying).toBe(false);
  });

  it("still reads the row of a lane whose harness does report quota", () => {
    // The same wall on the Claude lane closes the gate as before: the
    // capability gates the read, it does not switch quota off.
    recordQuotaObservation(CLAUDE_LANE_ID, REJECTED);

    const guards = readMoneyGuards(NOW, {
      ...getFleetSettings(),
      overrides: { primaryLane: CLAUDE_LANE_ID },
    });

    expect(guards.lane?.id).toBe(CLAUDE_LANE_ID);
    expect(guards.quota?.status).toBe("rejected");
    expect(evaluateQuotaGate(guards.quota, 90, NOW).closed).toBe(true);
  });

  it("never calls a lane walled on a row its harness could not have written", () => {
    // The ranking reads every lane's row at once; the row under the silent
    // lane is dropped before it gets there, so the lane is judged on what it
    // can be judged on — availability, the floor, the money guards.
    recordQuotaObservation(SILENT_LANE_ID, REJECTED);
    recordQuotaObservation(CLAUDE_LANE_ID, REJECTED);

    const selection = readLaneSelection("implement", null, NOW, getFleetSettings());
    const byId = Object.fromEntries(selection.candidates.map((c) => [c.id, c]));

    expect(byId[SILENT_LANE_ID].ineligible).toBeNull();
    // The Claude lane's own wall is still its own.
    expect(byId[CLAUDE_LANE_ID].ineligible).toBe("walled");
  });

  it("keeps only the rows the fleet may act on", () => {
    const rows = {
      [SILENT_LANE_ID]: REJECTED,
      [CLAUDE_LANE_ID]: REJECTED,
      // A row under a lane the file no longer declares is dropped too: nothing
      // can be attributed to it.
      "retired-lane": REJECTED,
    };

    expect(Object.keys(actionableObservations(catalog(), rows))).toEqual([
      CLAUDE_LANE_ID,
    ]);
  });
});
