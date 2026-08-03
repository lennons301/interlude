import { describe, it, expect } from "vitest";
import { evaluatePreflight, type PreflightChecks } from "../preflight";
import { HUMAN_SIGNOFF_LABEL } from "../gates";

// The check-to-status/reason mapping is the whole safety property here: a repo
// is only "passing" when every requirement holds, and a failure must name what
// is missing. computePreflight's GitHub I/O is a thin shell over this; the pure
// function is what gets exhaustive coverage.

const ALL_PASS: PreflightChecks = {
  repoConfigured: true,
  appInstalled: true,
  branchProtected: true,
  reviewerIsCollaborator: true,
  signoffLabelExists: true,
};

describe("evaluatePreflight", () => {
  it("passes with no reason when every check holds", () => {
    expect(evaluatePreflight(ALL_PASS)).toEqual({ status: "passing", reason: null });
  });

  it("fails on an unconfigured repo, ignoring downstream noise", () => {
    // A repo with nothing else set must not read as 'App missing' — the reason
    // is the prerequisite that actually blocks the owner.
    const result = evaluatePreflight({
      repoConfigured: false,
      appInstalled: false,
      branchProtected: false,
      reviewerIsCollaborator: false,
      signoffLabelExists: false,
    });
    expect(result.status).toBe("failing");
    expect(result.reason).toBe("no GitHub repo configured (needs gitUrl and githubRepo)");
  });

  it("short-circuits to the App reason when the App is missing", () => {
    // Prerequisite failure hides the checks that couldn't be gathered anyway.
    const result = evaluatePreflight({
      ...ALL_PASS,
      appInstalled: false,
      branchProtected: false,
      reviewerIsCollaborator: false,
      signoffLabelExists: false,
    });
    expect(result.status).toBe("failing");
    expect(result.reason).toBe("the GitHub App is not installed on the repository");
  });

  it("names a missing branch protection", () => {
    const result = evaluatePreflight({ ...ALL_PASS, branchProtected: false });
    expect(result.status).toBe("failing");
    expect(result.reason).toBe("no branch protection on the default branch");
  });

  it("names a reviewer that is not a collaborator", () => {
    const result = evaluatePreflight({ ...ALL_PASS, reviewerIsCollaborator: false });
    expect(result.status).toBe("failing");
    expect(result.reason).toBe("the reviewer account is not a collaborator");
  });

  it("names a missing human-signoff label", () => {
    const result = evaluatePreflight({ ...ALL_PASS, signoffLabelExists: false });
    expect(result.status).toBe("failing");
    expect(result.reason).toBe(`the "${HUMAN_SIGNOFF_LABEL}" label is missing`);
  });

  it("accumulates every independent failure into one reason", () => {
    const result = evaluatePreflight({
      repoConfigured: true,
      appInstalled: true,
      branchProtected: false,
      reviewerIsCollaborator: false,
      signoffLabelExists: false,
    });
    expect(result.status).toBe("failing");
    expect(result.reason).toBe(
      `no branch protection on the default branch; the reviewer account is not a collaborator; the "${HUMAN_SIGNOFF_LABEL}" label is missing`
    );
  });
});
