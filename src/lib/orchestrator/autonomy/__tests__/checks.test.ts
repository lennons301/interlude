import { describe, it, expect } from "vitest";
import { observeCheckRollup, type CheckObservation } from "../checks";

const HEAD = "d9d06fc";

describe("observeCheckRollup (issue #130)", () => {
  it("records the first failing sweep without confirming it", () => {
    expect(observeCheckRollup(undefined, HEAD, "failing")).toEqual({
      headSha: HEAD,
      sweepsFailing: 1,
    });
  });

  it("confirms a rollup still failing on the next sweep", () => {
    const first: CheckObservation = { headSha: HEAD, sweepsFailing: 1 };

    expect(observeCheckRollup(first, HEAD, "failing")).toEqual({
      headSha: HEAD,
      sweepsFailing: 2,
    });
  });

  it("restarts the count when a push moves the head", () => {
    // A new head is a new rollup: its failure earns its own confirmation
    // rather than inheriting the previous commit's.
    const first: CheckObservation = { headSha: "old-sha", sweepsFailing: 1 };

    expect(observeCheckRollup(first, HEAD, "failing")).toEqual({
      headSha: HEAD,
      sweepsFailing: 1,
    });
  });

  it("forgets the observation while checks are still running", () => {
    // Pending is treated like unknown mergeability: re-polled, never a verdict.
    const first: CheckObservation = { headSha: HEAD, sweepsFailing: 1 };

    expect(observeCheckRollup(first, HEAD, "pending")).toBeNull();
  });

  it.each(["passing", "none", "unknown"] as const)(
    "forgets the observation when the rollup reads %s",
    (state) => {
      const confirmed: CheckObservation = { headSha: HEAD, sweepsFailing: 2 };

      expect(observeCheckRollup(confirmed, HEAD, state)).toBeNull();
    }
  );
});
