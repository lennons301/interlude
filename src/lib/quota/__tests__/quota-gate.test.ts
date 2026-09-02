import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUOTA_PICKUP_THRESHOLD_PERCENT,
  QUOTA_OBSERVATION_STALE_MS,
  QUOTA_THRESHOLD_OPTIONS,
  evaluateQuotaGate,
} from "../quota-gate";
import type { QuotaObservation } from "../rate-limit-event";

/**
 * The quota admission gate (issue #171). Table-tested here as the pure
 * function two callers share — the reducer refuses pickup with it and the
 * dashboard banner names the hold with it — so the rules live in one place and
 * the reducer's own tests can be about pickup rather than about arithmetic.
 */

const NOW = new Date(2026, 8, 1, 12, 0, 0);

function observation(over: Partial<QuotaObservation> = {}): QuotaObservation {
  return {
    status: "allowed",
    rateLimitType: "five_hour",
    utilization: 10,
    resetsAt: new Date(NOW.getTime() + 60 * 60_000),
    overageStatus: null,
    overageResetsAt: null,
    isUsingOverage: null,
    overageInUse: null,
    observedAt: new Date(NOW.getTime() - 60_000),
    ...over,
  };
}

describe("the quota admission gate", () => {
  it("is open when nothing has ever been observed", () => {
    // A fresh install, or one on API-key auth where the CLI emits no quota
    // telemetry at all (#165's finding 6). Silence the fleet cannot break must
    // never read as a wall.
    const gate = evaluateQuotaGate(null, 90, NOW);

    expect(gate.closed).toBe(false);
    expect(gate.reason).toBeNull();
    expect(gate.observedAt).toBeNull();
  });

  it.each([
    { utilization: 10, closed: false },
    { utilization: 89, closed: false },
    { utilization: 90, closed: true },
    { utilization: 99.5, closed: true },
    { utilization: 100, closed: true },
  ])(
    "at $utilization% of a 90% threshold, closed = $closed",
    ({ utilization, closed }) => {
      const gate = evaluateQuotaGate(observation({ utilization }), 90, NOW);

      expect(gate.closed).toBe(closed);
      expect(gate.reason).toBe(closed ? "utilization" : null);
    }
  );

  it("closes on an account-wide rejection whatever the utilization says", () => {
    // The account is already refusing requests, so a threshold has nothing to
    // weigh: work started now cannot run.
    const gate = evaluateQuotaGate(
      observation({ status: "rejected", utilization: 4 }),
      90,
      NOW
    );

    expect(gate.closed).toBe(true);
    expect(gate.reason).toBe("rejected");
  });

  it("still closes on a rejection at a 100% threshold — the one thing no threshold turns off", () => {
    const gate = evaluateQuotaGate(
      observation({ status: "rejected", utilization: null }),
      100,
      NOW
    );

    expect(gate.closed).toBe(true);
    expect(gate.reason).toBe("rejected");
  });

  it("treats an absent utilization as unreported, never as 0% or 100%", () => {
    // #167 established the field is frequently missing rather than null or
    // zero. A missing one decides nothing either way; the status still can.
    expect(
      evaluateQuotaGate(observation({ utilization: null }), 50, NOW).closed
    ).toBe(false);
    expect(
      evaluateQuotaGate(
        observation({ status: "allowed_warning", utilization: null }),
        50,
        NOW
      ).closed
    ).toBe(false);
  });

  it("does not gate on a status this build has never heard of", () => {
    // Unknown reads as itself and decides nothing: only `rejected` is the
    // account saying no, and a later CLI's new member must not stop the fleet
    // by accident.
    const gate = evaluateQuotaGate(
      observation({ status: "throttled_soft", utilization: 4 }),
      90,
      NOW
    );

    expect(gate.closed).toBe(false);
  });

  it("stops gating once the observed window's stated reset has passed", () => {
    // Load-bearing, not tidiness: only a pass making an API call produces a
    // fresh observation, so a gate held by a stale rejection would suppress
    // the very traffic that would lift it.
    const walled = observation({
      status: "rejected",
      resetsAt: new Date(NOW.getTime() - 1),
    });

    expect(evaluateQuotaGate(walled, 90, NOW).closed).toBe(false);
  });

  it("holds right up to the stated reset", () => {
    const walled = observation({
      status: "rejected",
      resetsAt: new Date(NOW.getTime() + 1),
    });

    expect(evaluateQuotaGate(walled, 90, NOW).closed).toBe(true);
  });

  it("stops gating on a reset-less observation once it is older than a window", () => {
    // Some events carry no reset at all, so the age bound is the only thing
    // that could ever lift a gate they closed.
    const stale = observation({
      status: "rejected",
      resetsAt: null,
      observedAt: new Date(NOW.getTime() - QUOTA_OBSERVATION_STALE_MS),
    });
    const fresh = observation({
      status: "rejected",
      resetsAt: null,
      observedAt: new Date(NOW.getTime() - QUOTA_OBSERVATION_STALE_MS + 1_000),
    });

    expect(evaluateQuotaGate(stale, 90, NOW).closed).toBe(false);
    expect(evaluateQuotaGate(fresh, 90, NOW).closed).toBe(true);
  });

  it("carries the observation it judged, so every surface quotes one number", () => {
    const gate = evaluateQuotaGate(
      observation({ status: "allowed_warning", utilization: 94 }),
      85,
      NOW
    );

    expect(gate).toMatchObject({
      closed: true,
      reason: "utilization",
      thresholdPercent: 85,
      status: "allowed_warning",
      rateLimitType: "five_hour",
      utilization: 94,
    });
  });

  it("offers its own default among the thresholds the UI can set", () => {
    // A default the screen cannot select would be a state an operator could
    // leave but never return to.
    expect(QUOTA_THRESHOLD_OPTIONS).toContain(
      String(DEFAULT_QUOTA_PICKUP_THRESHOLD_PERCENT)
    );
  });
});
