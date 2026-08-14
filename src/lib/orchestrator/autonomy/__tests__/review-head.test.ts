import { describe, it, expect } from "vitest";
import { observeReviewedHead } from "../review-head";

// The LPS #180 shape: approved at d9d06fc, then two "Update branch" merges.
const REVIEWED = "d9d06fc";
const MOVED = "c327f5e1";

describe("observeReviewedHead (issue #131)", () => {
  it("reports the movement when the head is past the reviewed commit", () => {
    expect(observeReviewedHead(REVIEWED, MOVED)).toEqual({
      reviewedHeadSha: REVIEWED,
      headSha: MOVED,
    });
  });

  it("reports nothing while the head is still the reviewed commit", () => {
    // The no-churn rule: an unmoved head must cost nothing, sweep after sweep.
    expect(observeReviewedHead(REVIEWED, REVIEWED)).toBeNull();
  });

  it("reports nothing when no verdict has been posted yet", () => {
    // Nothing was reviewed, so nothing can be stale — the run is either
    // awaiting its first review or mid-cycle, both handled elsewhere.
    expect(observeReviewedHead(null, MOVED)).toBeNull();
  });
});
