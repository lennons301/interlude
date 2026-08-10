import { describe, it, expect } from "vitest";
import { evaluatePreflight, type PreflightChecks } from "../preflight";
import { HUMAN_SIGNOFF_LABEL } from "../gates";

// The check-to-status/reason mapping is the whole safety property here: a repo
// is only "passing" when every requirement holds, and a failure must name what
// is missing — and, per issue #70, name the *right* missing thing: an
// unreachable repo, a forbidden endpoint, and an unprotected branch are three
// different owner actions. computePreflight's GitHub I/O is a thin shell over
// this; the pure function is what gets exhaustive coverage.

const ALL_PASS: PreflightChecks = {
  repoConfigured: true,
  repo: "owner/repo",
  repoAccess: "accessible",
  branchProtection: "protected",
  reviewerIsCollaborator: true,
  signoffLabelExists: true,
  issuesWritable: true,
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
      repo: "",
      repoAccess: "inaccessible",
      branchProtection: "unprotected",
      reviewerIsCollaborator: false,
      signoffLabelExists: false,
      issuesWritable: false,
    });
    expect(result.status).toBe("failing");
    expect(result.reason).toBe("no GitHub repo configured (needs gitUrl and githubRepo)");
  });

  it("short-circuits to the access reason, naming the repo, when inaccessible", () => {
    // Prerequisite failure hides the checks that couldn't be gathered anyway,
    // and names the repo so the owner knows which installation to fix.
    const result = evaluatePreflight({
      ...ALL_PASS,
      repoAccess: "inaccessible",
      branchProtection: "unprotected",
      reviewerIsCollaborator: false,
      signoffLabelExists: false,
    });
    expect(result.status).toBe("failing");
    expect(result.reason).toBe(
      "the GitHub App cannot access owner/repo — add it to the App installation"
    );
  });

  it("reports a transient reach failure as retryable, not as a config fix", () => {
    // A network/500 blip must not tell the owner to touch an installation that
    // isn't broken — it's a different reason from `inaccessible` (issue #70).
    const result = evaluatePreflight({
      ...ALL_PASS,
      repoAccess: "unreachable",
      branchProtection: "unprotected",
      reviewerIsCollaborator: false,
      signoffLabelExists: false,
    });
    expect(result.status).toBe("failing");
    expect(result.reason).toBe("could not reach GitHub to check owner/repo — will retry");
  });

  it("names the missing App permission when branch protection is forbidden", () => {
    // A 403 on getBranchProtection is a permission gap, not a missing
    // protection — the owner grants "Administration: read", they don't add a
    // protection rule (issue #70).
    const result = evaluatePreflight({ ...ALL_PASS, branchProtection: "forbidden" });
    expect(result.status).toBe("failing");
    expect(result.reason).toBe(
      'the GitHub App lacks the "Administration: read" permission needed to read branch protection on owner/repo'
    );
  });

  it("names a genuinely unprotected default branch", () => {
    const result = evaluatePreflight({ ...ALL_PASS, branchProtection: "unprotected" });
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

  it("names a missing Issues:write permission for generation sessions", () => {
    // The one grant every generation skill needs — issue creation, comments,
    // labels, dependency edges, and sub-issues all live under Issues:write, so a
    // single failure names them all (issue #62).
    const result = evaluatePreflight({ ...ALL_PASS, issuesWritable: false });
    expect(result.status).toBe("failing");
    expect(result.reason).toBe(
      'the GitHub App lacks the "Issues: write" permission needed for issue creation, comments, labels, dependency edges, and sub-issues'
    );
  });

  it("accumulates every independent failure into one reason", () => {
    const result = evaluatePreflight({
      repoConfigured: true,
      repo: "owner/repo",
      repoAccess: "accessible",
      branchProtection: "unprotected",
      reviewerIsCollaborator: false,
      signoffLabelExists: false,
      issuesWritable: false,
    });
    expect(result.status).toBe("failing");
    expect(result.reason).toBe(
      `no branch protection on the default branch; the reviewer account is not a collaborator; the "${HUMAN_SIGNOFF_LABEL}" label is missing; the GitHub App lacks the "Issues: write" permission needed for issue creation, comments, labels, dependency edges, and sub-issues`
    );
  });

  it("accumulates a forbidden protection probe alongside other failures", () => {
    // The forbidden reason participates in accumulation just like the others,
    // so a repo with several gaps still lists them all in one pass.
    const result = evaluatePreflight({
      ...ALL_PASS,
      branchProtection: "forbidden",
      signoffLabelExists: false,
    });
    expect(result.status).toBe("failing");
    expect(result.reason).toBe(
      `the GitHub App lacks the "Administration: read" permission needed to read branch protection on owner/repo; the "${HUMAN_SIGNOFF_LABEL}" label is missing`
    );
  });
});
