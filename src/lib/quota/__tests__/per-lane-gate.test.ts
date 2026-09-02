import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/test/create-test-db";
import { evaluateQuotaGate } from "../quota-gate";
import type { QuotaObservation } from "../rate-limit-event";

/**
 * The invariant issue #175 exists for, end to end: **a lane that emits no
 * rate-limit telemetry is never gated by another lane's observation.**
 *
 * Three pieces have to line up for that to hold, and each is correct alone —
 * which is why it is worth a test that puts them together. The store keys an
 * observation by the lane it was seen on; `currentPrimaryLane` answers which
 * lane a pass would run on now; and the gate treats *no* observation as open.
 * Read fleet-wide instead, the subscription's last rejection would close the
 * gate over a metered lane that cannot be rate-limited at all — holding every
 * pickup on a fleet that was, on that lane, entirely free to work. That is a
 * wedge, and the only visible symptom would be a dashboard saying "quota".
 *
 * Run against the real checked-in `lanes.yaml`, deliberately: a fixture
 * catalog would pass while the shipped file named lanes that behaved
 * differently.
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
const { currentPrimaryLane } = await import("@/lib/lanes/primary-lane");
const { resetLaneCatalog } = await import("@/lib/lanes/catalog");
const { resetConfig } = await import("@/lib/config");

const NOW = new Date("2026-09-02T12:00:00.000Z");

/** A live wall on the subscription account: rejected, with hours to run. */
const REJECTED: QuotaObservation = {
  status: "rejected",
  rateLimitType: "five_hour",
  utilization: 100,
  resetsAt: new Date("2026-09-02T16:00:00.000Z"),
  overageStatus: null,
  overageResetsAt: null,
  isUsingOverage: false,
  overageInUse: null,
  observedAt: new Date("2026-09-02T11:59:00.000Z"),
};

beforeEach(() => {
  testDb = createTestDb().db;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test";
  process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
  delete process.env.AGENT_LANE;
  resetConfig();
  resetLaneCatalog();
});

/** The gate as the sweep computes it: this lane's row, judged at NOW. */
function gateFor(overrides: { primaryLane?: string }) {
  const lane = currentPrimaryLane(overrides);
  return {
    lane,
    gate: evaluateQuotaGate(getQuotaObservation(lane?.id ?? null), 90, NOW),
  };
}

describe("the admission gate is per lane", () => {
  it("closes on the lane the wall was observed on", () => {
    recordQuotaObservation("claude-subscription", REJECTED);

    const { lane, gate } = gateFor({});

    // The file's preference order puts the subscription lane first, and its
    // credential is set, so this is where an unconfigured fleet lands.
    expect(lane?.id).toBe("claude-subscription");
    expect(gate.closed).toBe(true);
    expect(gate.reason).toBe("rejected");
  });

  it("stays open on a metered lane while that same wall stands", () => {
    // The failure this prevents. OpenRouter emits no `anthropic-ratelimit-*`
    // header and no `rate_limit_event` at all (measured 2026-09-02), so this
    // lane's row is empty *permanently* — not pending. Its work is bounded by
    // spend, and the subscription's window says nothing about it.
    recordQuotaObservation("claude-subscription", REJECTED);

    const { lane, gate } = gateFor({ primaryLane: "openrouter-glm" });

    expect(lane?.id).toBe("openrouter-glm");
    expect(lane?.billing).toBe("metered");
    expect(gate.closed).toBe(false);
    // And the subscription's own reading is untouched by the switch — the two
    // rows coexist, so switching back does not need a fresh observation.
    expect(getQuotaObservation("claude-subscription")?.status).toBe("rejected");
  });

  it("closes again the moment the fleet switches back", () => {
    // The other direction, which matters just as much: moving off a metered
    // lane must not leave the fleet running under a wall it had forgotten.
    recordQuotaObservation("claude-subscription", REJECTED);

    expect(gateFor({ primaryLane: "openrouter-glm" }).gate.closed).toBe(false);
    expect(gateFor({ primaryLane: "claude-subscription" }).gate.closed).toBe(
      true
    );
  });

  it("gates nothing when no lane resolves", () => {
    // An unusable or lane-less catalog: nothing is known about what the fleet
    // authenticates as, and a gate may not manufacture a wall out of that —
    // the same fail-open rule the admission probe follows (#115).
    recordQuotaObservation("claude-subscription", REJECTED);

    expect(gateFor({ primaryLane: "no-such-lane" }).lane?.id).toBe(
      "claude-subscription"
    );
    expect(
      evaluateQuotaGate(getQuotaObservation(null), 90, NOW).closed
    ).toBe(false);
  });
});
