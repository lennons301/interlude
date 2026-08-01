import { describe, it, expect } from "vitest";
import {
  decideNext,
  type AutonomySnapshot,
  type CandidateIssue,
  type ProjectSnapshot,
} from "../decide";

// Fixed clock — time arrives in the snapshot, never read inside the reducer
const NOW = new Date(2026, 7, 1, 12, 0, 0);
const ARMED_EARLY = new Date(2026, 7, 1, 9, 0, 0);

function makeProject(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    id: "proj-1",
    repo: "acme/widgets",
    autonomyEnabled: true,
    preflightStatus: "passing",
    preflightReason: null,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<CandidateIssue> = {}): CandidateIssue {
  return {
    issueRef: "acme/widgets#7",
    repo: "acme/widgets",
    number: 7,
    title: "Add the frobnicator",
    body: "Make the frobnicator frob.",
    author: "acme",
    labels: ["ready-for-agent"],
    armedAt: ARMED_EARLY,
    hasOpenBlocker: false,
    attemptsMade: 0,
    hasActiveRun: false,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<AutonomySnapshot> = {}): AutonomySnapshot {
  return {
    now: NOW,
    autonomyEnabledGlobal: true,
    attemptBudgetUsd: 20,
    maxAttempts: 3,
    allowedAuthors: [],
    slots: { total: 2, occupied: 0, occupants: [] },
    queuedInteractiveCount: 0,
    saturationAnnounced: false,
    projects: [makeProject()],
    candidates: [makeCandidate()],
    inFlightClaims: [],
    ...overrides,
  };
}

describe("decideNext — claiming", () => {
  it("claims an eligible issue when a slot is free", () => {
    const actions = decideNext(makeSnapshot());

    expect(actions).toEqual([
      {
        type: "claimIssue",
        issueRef: "acme/widgets#7",
        projectId: "proj-1",
        issueNumber: 7,
        issueTitle: "Add the frobnicator",
        issueBody: "Make the frobnicator frob.",
        attempt: 1,
        mode: "autonomous",
        budgetUsd: 20,
        workflow: { source: "default" },
      },
    ]);
  });
});
