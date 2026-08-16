import { describe, it, expect } from "vitest";
import {
  armBlocker,
  canArm,
  preflightVerdict,
  type ProjectAutonomy,
} from "../autonomy";

function makeProject(
  overrides: Partial<ProjectAutonomy> = {}
): ProjectAutonomy {
  return {
    autonomyEnabled: false,
    preflightStatus: null,
    preflightReason: null,
    ...overrides,
  };
}

describe("canArm", () => {
  it("arms a project whose preflight passes", () => {
    expect(canArm(makeProject({ preflightStatus: "passing" }))).toBe(true);
  });

  it("arms a project preflight has never run for — arming is what runs it", () => {
    expect(canArm(makeProject({ preflightStatus: null }))).toBe(true);
  });

  it("refuses a project whose preflight is failing", () => {
    expect(
      canArm(
        makeProject({
          preflightStatus: "failing",
          preflightReason: "lennons301/lemons: default branch is unprotected",
        })
      )
    ).toBe(false);
  });

  it("refuses a failing project even with a stale reason from a past pass", () => {
    // The status is the verdict; a reason left over from an earlier check must
    // never be what decides whether the affordance is offered.
    expect(
      canArm(
        makeProject({ preflightStatus: "failing", preflightReason: null })
      )
    ).toBe(false);
  });

  it("does not care whether the project is already armed", () => {
    // Arming is gated on the repo being ready, not on the switch's position:
    // an armed-but-failing project must not become armable by being armed.
    expect(
      canArm(
        makeProject({ autonomyEnabled: true, preflightStatus: "failing" })
      )
    ).toBe(false);
    expect(
      canArm(
        makeProject({ autonomyEnabled: true, preflightStatus: "passing" })
      )
    ).toBe(true);
  });
});

describe("armBlocker", () => {
  it("names what is missing, so the owner can act on it", () => {
    expect(
      armBlocker(
        makeProject({
          preflightStatus: "failing",
          preflightReason: "reviewer is not a collaborator on lennons301/lemons",
        })
      )
    ).toBe("reviewer is not a collaborator on lennons301/lemons");
  });

  it("still says the preflight failed when no reason was recorded", () => {
    expect(
      armBlocker(makeProject({ preflightStatus: "failing" }))
    ).toBe("preflight failed for an unrecorded reason");
  });

  it("blocks nothing when preflight passes or has never run", () => {
    expect(armBlocker(makeProject({ preflightStatus: "passing" }))).toBeNull();
    expect(armBlocker(makeProject({ preflightStatus: null }))).toBeNull();
  });

  it("ignores a reason carried alongside a passing status", () => {
    expect(
      armBlocker(
        makeProject({
          preflightStatus: "passing",
          preflightReason: "branch protection missing",
        })
      )
    ).toBeNull();
  });
});

describe("preflightVerdict", () => {
  it("reads a passing preflight as green with nothing more to say", () => {
    expect(preflightVerdict(makeProject({ preflightStatus: "passing" }))).toEqual({
      state: "passing",
      tone: "green",
      detail: null,
    });
  });

  it("reads a failing preflight as amber, carrying the reason", () => {
    expect(
      preflightVerdict(
        makeProject({
          preflightStatus: "failing",
          preflightReason: "the App cannot reach lennons301/lemons",
        })
      )
    ).toEqual({
      state: "failing",
      tone: "amber",
      detail: "the App cannot reach lennons301/lemons",
    });
  });

  it("reads a never-run preflight as quiet, saying arming will run it", () => {
    const verdict = preflightVerdict(makeProject({ preflightStatus: null }));

    expect(verdict.state).toBe("unchecked");
    expect(verdict.tone).toBe("quiet");
    expect(verdict.detail).toContain("never run");
  });
});
