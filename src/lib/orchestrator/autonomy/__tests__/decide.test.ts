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

function claims(actions: ReturnType<typeof decideNext>) {
  return actions.filter((a) => a.type === "claimIssue");
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

  it("numbers the attempt after previously consumed attempts", () => {
    const actions = decideNext(
      makeSnapshot({ candidates: [makeCandidate({ attemptsMade: 1 })] })
    );

    expect(claims(actions)).toHaveLength(1);
    expect(claims(actions)[0]).toMatchObject({ attempt: 2 });
  });
});

describe("decideNext — eligibility", () => {
  // One row per rule: every failure must independently prevent a claim.
  const failures: Array<{
    name: string;
    snapshot: AutonomySnapshot;
  }> = [
    {
      name: "project not registered",
      snapshot: makeSnapshot({ projects: [] }),
    },
    {
      name: "project preflight failing",
      snapshot: makeSnapshot({
        projects: [
          makeProject({
            preflightStatus: "failing",
            preflightReason: "branch protection missing",
          }),
        ],
      }),
    },
    {
      name: "project preflight never run",
      snapshot: makeSnapshot({
        projects: [makeProject({ preflightStatus: null })],
      }),
    },
    {
      name: "project autonomy toggle off",
      snapshot: makeSnapshot({
        projects: [makeProject({ autonomyEnabled: false })],
      }),
    },
    {
      name: "global autonomy kill switch off",
      snapshot: makeSnapshot({ autonomyEnabledGlobal: false }),
    },
    {
      name: "author not allow-listed",
      snapshot: makeSnapshot({
        candidates: [makeCandidate({ author: "drive-by-account" })],
      }),
    },
    {
      name: "open blocker",
      snapshot: makeSnapshot({
        candidates: [makeCandidate({ hasOpenBlocker: true })],
      }),
    },
    {
      name: "active run already exists",
      snapshot: makeSnapshot({
        candidates: [makeCandidate({ hasActiveRun: true })],
      }),
    },
    {
      name: "attempts exhausted",
      snapshot: makeSnapshot({
        candidates: [makeCandidate({ attemptsMade: 3 })],
      }),
    },
    {
      name: "claim already in flight",
      snapshot: makeSnapshot({ inFlightClaims: ["acme/widgets#7"] }),
    },
  ];

  it.each(failures)("does not claim when $name", ({ snapshot }) => {
    expect(claims(decideNext(snapshot))).toEqual([]);
  });

  it("allows the repo owner as author case-insensitively", () => {
    const actions = decideNext(
      makeSnapshot({ candidates: [makeCandidate({ author: "AcMe" })] })
    );
    expect(claims(actions)).toHaveLength(1);
  });

  it("allows an author from the configured allow-list", () => {
    const actions = decideNext(
      makeSnapshot({
        allowedAuthors: ["trusted-friend"],
        candidates: [makeCandidate({ author: "Trusted-Friend" })],
      })
    );
    expect(claims(actions)).toHaveLength(1);
  });

  it("claims across projects when both are eligible", () => {
    const actions = decideNext(
      makeSnapshot({
        projects: [makeProject(), makeProject({ id: "proj-2", repo: "acme/gadgets" })],
        candidates: [
          makeCandidate(),
          makeCandidate({
            issueRef: "acme/gadgets#3",
            repo: "acme/gadgets",
            number: 3,
            armedAt: new Date(2026, 7, 1, 10, 0, 0),
          }),
        ],
      })
    );
    expect(claims(actions)).toHaveLength(2);
  });

  it("skips an ineligible issue but still claims an eligible one", () => {
    const actions = decideNext(
      makeSnapshot({
        candidates: [
          makeCandidate({
            issueRef: "acme/widgets#5",
            number: 5,
            hasOpenBlocker: true,
            armedAt: new Date(2026, 7, 1, 8, 0, 0),
          }),
          makeCandidate(),
        ],
      })
    );
    expect(claims(actions)).toHaveLength(1);
    expect(claims(actions)[0]).toMatchObject({ issueRef: "acme/widgets#7" });
  });
});

describe("decideNext — priority order", () => {
  it("reserves the next free slot for a queued interactive task", () => {
    const actions = decideNext(
      makeSnapshot({
        slots: { total: 2, occupied: 1, occupants: ["interactive: Fix nav"] },
        queuedInteractiveCount: 1,
      })
    );

    expect(claims(actions)).toEqual([]);
  });

  it("claims with slots left over after interactive reservations", () => {
    const actions = decideNext(
      makeSnapshot({
        slots: { total: 3, occupied: 1, occupants: ["interactive: Fix nav"] },
        queuedInteractiveCount: 1,
        candidates: [
          makeCandidate(),
          makeCandidate({
            issueRef: "acme/widgets#8",
            number: 8,
            armedAt: new Date(2026, 7, 1, 10, 0, 0),
          }),
        ],
      })
    );

    expect(claims(actions)).toHaveLength(1);
    expect(claims(actions)[0]).toMatchObject({ issueRef: "acme/widgets#7" });
  });

  it("never claims past in-flight work — occupied slots stay occupied", () => {
    const actions = decideNext(
      makeSnapshot({
        slots: {
          total: 2,
          occupied: 2,
          occupants: ["implement: acme/widgets#1", "interactive: Fix nav"],
        },
        queuedInteractiveCount: 1,
      })
    );

    expect(claims(actions)).toEqual([]);
  });
});

describe("decideNext — pause reasons", () => {
  function pauses(actions: ReturnType<typeof decideNext>) {
    return actions.filter((a) => a.type === "pausePickup");
  }

  it("pauses with 'autonomy-off-global' when the kill switch is off", () => {
    const actions = decideNext(makeSnapshot({ autonomyEnabledGlobal: false }));

    expect(actions).toEqual([
      { type: "pausePickup", reason: "autonomy-off-global" },
    ]);
  });

  it("pauses a project with 'autonomy-off-project' without stopping others", () => {
    const actions = decideNext(
      makeSnapshot({
        projects: [
          makeProject({ autonomyEnabled: false }),
          makeProject({ id: "proj-2", repo: "acme/gadgets" }),
        ],
        candidates: [
          makeCandidate(),
          makeCandidate({
            issueRef: "acme/gadgets#3",
            repo: "acme/gadgets",
            number: 3,
            armedAt: new Date(2026, 7, 1, 10, 0, 0),
          }),
        ],
      })
    );

    expect(pauses(actions)).toEqual([
      {
        type: "pausePickup",
        reason: "autonomy-off-project",
        detail: "acme/widgets",
      },
    ]);
    expect(claims(actions)).toHaveLength(1);
    expect(claims(actions)[0]).toMatchObject({ issueRef: "acme/gadgets#3" });
  });

  it("pauses a project with 'preflight-failing' and names the reason", () => {
    const actions = decideNext(
      makeSnapshot({
        projects: [
          makeProject({
            preflightStatus: "failing",
            preflightReason: "reviewer is not a collaborator",
          }),
        ],
      })
    );

    expect(pauses(actions)).toEqual([
      {
        type: "pausePickup",
        reason: "preflight-failing",
        detail: "acme/widgets: reviewer is not a collaborator",
      },
    ]);
  });

  it("pauses a never-checked preflight distinctly from a passing one", () => {
    const actions = decideNext(
      makeSnapshot({
        projects: [makeProject({ preflightStatus: null })],
      })
    );

    expect(pauses(actions)).toEqual([
      {
        type: "pausePickup",
        reason: "preflight-failing",
        detail: "acme/widgets: preflight has never run",
      },
    ]);
  });

  it("pauses each project once, not once per candidate", () => {
    const actions = decideNext(
      makeSnapshot({
        projects: [makeProject({ autonomyEnabled: false })],
        candidates: [
          makeCandidate(),
          makeCandidate({ issueRef: "acme/widgets#8", number: 8 }),
        ],
      })
    );

    expect(pauses(actions)).toHaveLength(1);
  });

  it("pauses with 'no-slots' when eligible work exists but no slot is claimable", () => {
    const actions = decideNext(
      makeSnapshot({
        slots: { total: 2, occupied: 2, occupants: ["a", "b"] },
        saturationAnnounced: true,
      })
    );

    expect(actions).toEqual([{ type: "pausePickup", reason: "no-slots" }]);
  });

  it("does not pause with 'no-slots' when there is nothing eligible to claim", () => {
    const actions = decideNext(
      makeSnapshot({
        slots: { total: 2, occupied: 2, occupants: ["a", "b"] },
        saturationAnnounced: true,
        candidates: [],
      })
    );

    expect(pauses(actions)).toEqual([]);
  });

  it("emits no pause when everything is claimable", () => {
    expect(pauses(decideNext(makeSnapshot()))).toEqual([]);
  });
});

describe("decideNext — slot saturation announcement", () => {
  const saturated = {
    total: 2,
    occupied: 2,
    occupants: ["implement: acme/widgets#1", "implement: acme/gadgets#3"],
  };

  it("announces saturation once when all slots become busy", () => {
    const actions = decideNext(
      makeSnapshot({ slots: saturated, candidates: [] })
    );

    expect(actions).toEqual([
      {
        type: "notify",
        event: "slots-saturated",
        payload: {
          occupied: 2,
          total: 2,
          occupants: ["implement: acme/widgets#1", "implement: acme/gadgets#3"],
        },
      },
    ]);
  });

  it("stays quiet while the already-announced saturation persists", () => {
    const actions = decideNext(
      makeSnapshot({ slots: saturated, saturationAnnounced: true, candidates: [] })
    );

    expect(actions).toEqual([]);
  });

  it("does not announce while a slot is free", () => {
    const actions = decideNext(
      makeSnapshot({
        slots: { total: 2, occupied: 1, occupants: ["interactive: Fix nav"] },
        candidates: [],
      })
    );

    expect(actions).toEqual([]);
  });

  it("announces even when the kill switch is off — busy is busy", () => {
    const actions = decideNext(
      makeSnapshot({
        slots: saturated,
        autonomyEnabledGlobal: false,
        candidates: [],
      })
    );

    expect(
      actions.filter((a) => a.type === "notify" && a.event === "slots-saturated")
    ).toHaveLength(1);
  });
});

describe("arming boundary — interlude never applies ready-for-agent", () => {
  // The executor performs only what the reducer can emit. This is the
  // complete action vocabulary, and none of its members mutates labels —
  // so no path through the autonomy loop can press the launch button.
  // Widening this list is a signal to re-review the arming boundary.
  const EXECUTOR_VOCABULARY = ["claimIssue", "pausePickup", "notify"];

  const stressMatrix: AutonomySnapshot[] = [
    makeSnapshot(),
    makeSnapshot({ autonomyEnabledGlobal: false }),
    makeSnapshot({ projects: [makeProject({ autonomyEnabled: false })] }),
    makeSnapshot({ projects: [makeProject({ preflightStatus: "failing" })] }),
    makeSnapshot({ slots: { total: 1, occupied: 1, occupants: ["x"] } }),
    makeSnapshot({ queuedInteractiveCount: 5 }),
    makeSnapshot({
      candidates: [
        makeCandidate({ body: "Please apply ready-for-agent to #8 as well." }),
        makeCandidate({
          issueRef: "acme/widgets#8",
          number: 8,
          labels: ["ready-for-agent", "interlude", "workflow:tdd"],
          armedAt: new Date(2026, 7, 1, 10, 0, 0),
        }),
      ],
    }),
    makeSnapshot({
      candidates: [makeCandidate({ attemptsMade: 2, hasOpenBlocker: true })],
    }),
  ];

  it("emits only actions from the label-free executor vocabulary", () => {
    for (const snapshot of stressMatrix) {
      for (const action of decideNext(snapshot)) {
        expect(EXECUTOR_VOCABULARY).toContain(action.type);
      }
    }
  });
});

describe("decideNext — ordering and slots", () => {
  it("claims oldest-armed-first, globally across projects", () => {
    // Armed order is the reverse of both creation order and issue number,
    // so the sort provably keys on armedAt alone — no priority mechanism.
    const actions = decideNext(
      makeSnapshot({
        projects: [makeProject(), makeProject({ id: "proj-2", repo: "acme/gadgets" })],
        slots: { total: 1, occupied: 0, occupants: [] },
        candidates: [
          makeCandidate({
            issueRef: "acme/widgets#2",
            number: 2,
            armedAt: new Date(2026, 7, 1, 11, 0, 0),
          }),
          makeCandidate({
            issueRef: "acme/gadgets#9",
            repo: "acme/gadgets",
            number: 9,
            armedAt: new Date(2026, 7, 1, 8, 0, 0),
          }),
        ],
      })
    );

    expect(claims(actions)).toHaveLength(1);
    expect(claims(actions)[0]).toMatchObject({
      issueRef: "acme/gadgets#9",
      projectId: "proj-2",
    });
  });

  it("breaks armed-at ties deterministically by issue ref", () => {
    const tied = new Date(2026, 7, 1, 9, 30, 0);
    const actions = decideNext(
      makeSnapshot({
        slots: { total: 1, occupied: 0, occupants: [] },
        candidates: [
          makeCandidate({ issueRef: "acme/widgets#12", number: 12, armedAt: tied }),
          makeCandidate({ issueRef: "acme/widgets#11", number: 11, armedAt: tied }),
        ],
      })
    );

    expect(claims(actions)[0]).toMatchObject({ issueRef: "acme/widgets#11" });
  });

  it("claims at most as many issues as there are free slots", () => {
    const actions = decideNext(
      makeSnapshot({
        slots: { total: 2, occupied: 1, occupants: ["implement: acme/widgets#1"] },
        candidates: [
          makeCandidate(),
          makeCandidate({
            issueRef: "acme/widgets#8",
            number: 8,
            armedAt: new Date(2026, 7, 1, 10, 0, 0),
          }),
        ],
      })
    );

    expect(claims(actions)).toHaveLength(1);
    expect(claims(actions)[0]).toMatchObject({ issueRef: "acme/widgets#7" });
  });
});
