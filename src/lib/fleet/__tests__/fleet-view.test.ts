import { describe, it, expect } from "vitest";
import {
  buildFleetView,
  type FleetRows,
  type FleetProjectRow,
  type FleetRunRow,
  type FleetTaskRow,
} from "../fleet-view";

// Fixed clock: noon local time, so "today" and the 7-day window are unambiguous
const NOW = new Date(2026, 7, 1, 12, 0, 0);
const TODAY_9AM = new Date(2026, 7, 1, 9, 0, 0);

function baseRows(overrides: Partial<FleetRows> = {}): FleetRows {
  return {
    now: NOW,
    slots: 2,
    dailyCapUsd: 500,
    discordGuildId: null,
    projects: [],
    runs: [],
    tasks: [],
    backlogByProject: null,
    ...overrides,
  };
}

function makeProject(overrides: Partial<FleetProjectRow> = {}): FleetProjectRow {
  return {
    id: "proj-1",
    name: "lemons",
    autonomyEnabled: false,
    preflightStatus: null,
    preflightReason: null,
    discordChannelId: null,
    ...overrides,
  };
}

function makeRun(overrides: Partial<FleetRunRow> = {}): FleetRunRow {
  return {
    id: "run-1",
    projectId: "proj-1",
    githubIssue: "lennons301/lemons#34",
    attempt: 1,
    mode: "autonomous",
    status: "implementing",
    budgetUsd: 20,
    totalCostUsd: 0,
    pullRequestNumber: null,
    pullRequestUrl: null,
    blockedQuestion: null,
    integrationCount: 0,
    claimedAt: TODAY_9AM,
    startedAt: TODAY_9AM,
    finishedAt: null,
    ...overrides,
  };
}

function makeTask(overrides: Partial<FleetTaskRow> = {}): FleetTaskRow {
  return {
    id: "task-1",
    projectId: "proj-1",
    runId: null,
    kind: "interactive",
    title: "Polish the header",
    status: "running",
    containerStatus: "idle",
    totalCostUsd: 0,
    turns: 1,
    githubIssue: null,
    pullRequestNumber: null,
    pullRequestUrl: null,
    createdAt: TODAY_9AM,
    updatedAt: TODAY_9AM,
    ...overrides,
  };
}

describe("buildFleetView — slots", () => {
  it("renders an empty fleet: all slots free, not saturated", () => {
    const view = buildFleetView(baseRows());

    expect(view.slots.total).toBe(2);
    expect(view.slots.used).toBe(0);
    expect(view.slots.saturated).toBe(false);
    expect(view.slots.segments).toEqual([
      { occupant: "free" },
      { occupant: "free" },
    ]);
    expect(view.spend.todayUsd).toBe(0);
    expect(view.needsYou).toEqual([]);
    expect(view.running).toEqual([]);
    expect(view.recent.items).toEqual([]);
  });

  it("attributes a slot to an interactive session with a live container", () => {
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1", name: "interlude" })],
        tasks: [makeTask({ projectId: "p1", containerStatus: "idle" })],
      })
    );

    expect(view.slots.used).toBe(1);
    expect(view.slots.saturated).toBe(false);
    expect(view.slots.segments[0]).toEqual({
      occupant: "interactive",
      projectName: "interlude",
      taskId: "task-1",
      ticket: null,
    });
    expect(view.slots.segments[1]).toEqual({ occupant: "free" });
  });

  it("does not attribute a slot to a parked implement container awaiting review", () => {
    // Issue #17: an implement pass idling while its PR is reviewed keeps its
    // container (for the fix-up turn) but runs no agent and holds no slot.
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1", name: "interlude" })],
        tasks: [
          makeTask({ projectId: "p1", kind: "implement", containerStatus: "idle" }),
        ],
      })
    );

    expect(view.slots.used).toBe(0);
    expect(view.slots.segments).toEqual([
      { occupant: "free" },
      { occupant: "free" },
    ]);
  });

  it("attributes a slot to an autonomous run via its live task", () => {
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1", name: "lemons" })],
        runs: [makeRun({ id: "r1", projectId: "p1" })],
        tasks: [
          makeTask({
            id: "t-impl",
            projectId: "p1",
            runId: "r1",
            kind: "implement",
            containerStatus: "running",
          }),
        ],
      })
    );

    expect(view.slots.used).toBe(1);
    expect(view.slots.segments[0]).toEqual({
      occupant: "autonomous",
      projectName: "lemons",
      taskId: "t-impl",
      ticket: "#34",
    });
  });

  it("ignores tasks without a live container in slot accounting", () => {
    const view = buildFleetView(
      baseRows({
        projects: [makeProject()],
        tasks: [
          makeTask({ id: "done", status: "completed", containerStatus: null }),
          makeTask({ id: "waiting", status: "queued", containerStatus: null }),
        ],
      })
    );

    expect(view.slots.used).toBe(0);
  });

  it("never counts a terminal-status task as a slot occupant, even with a stale container_status", () => {
    // Issue #46: a task cancelled months ago still carried
    // container_status='idle' and rendered as a running interactive session.
    // Terminal status wins over a stale container column.
    for (const status of ["cancelled", "completed", "failed"] as const) {
      const view = buildFleetView(
        baseRows({
          projects: [makeProject({ id: "p1", name: "interlude" })],
          tasks: [
            makeTask({ projectId: "p1", status, containerStatus: "idle" }),
          ],
        })
      );

      expect(view.slots.used).toBe(0);
      expect(view.slots.segments).toEqual([
        { occupant: "free" },
        { occupant: "free" },
      ]);
      expect(view.running).toEqual([]);
    }
  });

  it("reports saturation with what it is attributable to", () => {
    const view = buildFleetView(
      baseRows({
        slots: 2,
        projects: [
          makeProject({ id: "p1", name: "lemons" }),
          makeProject({ id: "p2", name: "interlude" }),
        ],
        runs: [makeRun({ id: "r1", projectId: "p1" })],
        tasks: [
          makeTask({
            id: "t-impl",
            projectId: "p1",
            runId: "r1",
            kind: "implement",
            containerStatus: "running",
          }),
          makeTask({ id: "t-chat", projectId: "p2", containerStatus: "idle" }),
        ],
      })
    );

    expect(view.slots.used).toBe(2);
    expect(view.slots.saturated).toBe(true);
    expect(view.slots.segments.map((s) => s.occupant)).toEqual([
      "autonomous",
      "interactive",
    ]);
  });

  it("keeps every occupant visible even when containers exceed slots", () => {
    // A VPS downsize can shrink capacity below what is already running
    const view = buildFleetView(
      baseRows({
        slots: 1,
        projects: [makeProject({ id: "p1", name: "interlude" })],
        tasks: [
          makeTask({ id: "t1", projectId: "p1", containerStatus: "idle" }),
          makeTask({ id: "t2", projectId: "p1", containerStatus: "running" }),
        ],
      })
    );

    expect(view.slots.total).toBe(1);
    expect(view.slots.used).toBe(2);
    expect(view.slots.saturated).toBe(true);
    expect(view.slots.segments).toHaveLength(2);
  });
});

describe("buildFleetView — spend", () => {
  const YESTERDAY_11PM = new Date(2026, 6, 31, 23, 0, 0);

  it("sums today's run spend against the cap", () => {
    const view = buildFleetView(
      baseRows({
        runs: [
          makeRun({ id: "r1", totalCostUsd: 12.5 }),
          makeRun({ id: "r2", mode: "supervised", totalCostUsd: 7.25, status: "merged", finishedAt: TODAY_9AM }),
        ],
      })
    );

    expect(view.spend.todayUsd).toBeCloseTo(19.75);
    expect(view.spend.capUsd).toBe(500);
    expect(view.spend.capPaused).toBe(false);
  });

  it("excludes runs claimed after `now` from today's spend", () => {
    // The digest evaluates the view at the end of a past day over live rows;
    // a run claimed after that instant belongs to the next day's ledger.
    const view = buildFleetView(
      baseRows({
        runs: [
          makeRun({ id: "r1", totalCostUsd: 3 }),
          makeRun({
            id: "r-future",
            totalCostUsd: 480,
            claimedAt: new Date(2026, 7, 1, 13, 0, 0), // an hour past NOW
            startedAt: new Date(2026, 7, 1, 13, 0, 0),
          }),
        ],
      })
    );

    expect(view.spend.todayUsd).toBeCloseTo(3);
    expect(view.spend.capPaused).toBe(false);
  });

  it("excludes runs claimed before local midnight from today's spend", () => {
    const view = buildFleetView(
      baseRows({
        runs: [
          makeRun({ id: "r1", claimedAt: YESTERDAY_11PM, startedAt: YESTERDAY_11PM, totalCostUsd: 50 }),
          makeRun({ id: "r2", totalCostUsd: 3 }),
        ],
      })
    );

    expect(view.spend.todayUsd).toBeCloseTo(3);
  });

  it("excludes interactive task spend — exempt by construction", () => {
    const view = buildFleetView(
      baseRows({
        projects: [makeProject()],
        tasks: [makeTask({ totalCostUsd: 42.42 })],
        runs: [makeRun({ id: "r1", totalCostUsd: 1.5 })],
      })
    );

    expect(view.spend.todayUsd).toBeCloseTo(1.5);
  });

  it("pauses the fleet when today's spend reaches the cap", () => {
    const view = buildFleetView(
      baseRows({
        dailyCapUsd: 500,
        runs: [makeRun({ id: "r1", totalCostUsd: 500 })],
      })
    );

    expect(view.spend.capPaused).toBe(true);
  });
});

describe("buildFleetView — needs you", () => {
  it("raises a blocked question with a Discord deep link when the channel is known", () => {
    const view = buildFleetView(
      baseRows({
        discordGuildId: "guild-9",
        projects: [
          makeProject({ id: "p1", name: "lemons", discordChannelId: "chan-7" }),
        ],
        runs: [
          makeRun({
            id: "r1",
            projectId: "p1",
            status: "blocked",
            attempt: 2,
            blockedQuestion: "Which auth provider should I use?",
          }),
        ],
        tasks: [
          makeTask({
            id: "t1",
            projectId: "p1",
            runId: "r1",
            kind: "implement",
            status: "blocked",
            containerStatus: "idle",
          }),
        ],
      })
    );

    expect(view.needsYou).toHaveLength(1);
    expect(view.needsYou[0]).toEqual({
      cause: "blocked",
      severity: "amber",
      context: "lemons #34 · attempt 2/3",
      body: "Which auth provider should I use?",
      action: {
        label: "Answer in Discord",
        href: "https://discord.com/channels/guild-9/chan-7",
      },
    });
  });

  it("falls back to the task page when no Discord route exists", () => {
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1", name: "lemons" })],
        runs: [
          makeRun({
            id: "r1",
            projectId: "p1",
            status: "blocked",
            blockedQuestion: "Proceed with the schema change?",
          }),
        ],
        tasks: [
          makeTask({
            id: "t1",
            projectId: "p1",
            runId: "r1",
            kind: "implement",
            containerStatus: "idle",
          }),
        ],
      })
    );

    expect(view.needsYou[0].action).toEqual({
      label: "Open task",
      href: "/tasks/t1",
    });
  });

  it("raises a gated PR waiting for human sign-off", () => {
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1", name: "lemons" })],
        runs: [
          makeRun({
            id: "r1",
            projectId: "p1",
            status: "gated",
            pullRequestNumber: 55,
            pullRequestUrl: "https://github.com/lennons301/lemons/pull/55",
          }),
        ],
      })
    );

    expect(view.needsYou).toEqual([
      {
        cause: "signoff",
        severity: "amber",
        context: "lemons #34 · attempt 1/3",
        body: "PR #55 waits for your sign-off",
        action: {
          label: "Review PR #55",
          href: "https://github.com/lennons301/lemons/pull/55",
        },
      },
    ]);
  });

  it("raises a gated PR stalled on a merge conflict as a distinct red state (issue #54)", () => {
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1", name: "lemons" })],
        runs: [
          makeRun({
            id: "r1",
            projectId: "p1",
            status: "gated",
            // Integration repairs spent (MAX_INTEGRATION_ATTEMPTS = 1) and
            // still conflicting: not a plain sign-off.
            integrationCount: 1,
            pullRequestNumber: 55,
            pullRequestUrl: "https://github.com/lennons301/lemons/pull/55",
          }),
        ],
      })
    );

    expect(view.needsYou).toEqual([
      {
        cause: "conflict",
        severity: "red",
        context: "lemons #34 · attempt 1/3",
        body: "PR #55 still conflicts with the default branch — resolve and merge",
        action: {
          label: "Resolve PR #55",
          href: "https://github.com/lennons301/lemons/pull/55",
        },
      },
    ]);
  });

  it("keeps a repaired-and-mergeable gated PR as an ordinary sign-off", () => {
    // A successful repair resets integrationCount to 0, so the run reads as a
    // clean sign-off wait, not a conflict.
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1", name: "lemons" })],
        runs: [
          makeRun({
            id: "r1",
            projectId: "p1",
            status: "gated",
            integrationCount: 0,
            pullRequestNumber: 55,
            pullRequestUrl: "https://github.com/lennons301/lemons/pull/55",
          }),
        ],
      })
    );

    expect(view.needsYou.map((i) => i.cause)).toEqual(["signoff"]);
  });

  it("raises an exhausted ticket with a link to its issue", () => {
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1", name: "lemons" })],
        runs: [
          makeRun({
            id: "r1",
            projectId: "p1",
            attempt: 3,
            status: "exhausted",
            finishedAt: TODAY_9AM,
          }),
        ],
      })
    );

    expect(view.needsYou).toEqual([
      {
        cause: "exhausted",
        severity: "red",
        context: "lemons #34 · attempt 3/3",
        body: "Attempts exhausted — ticket is ready-for-human",
        action: {
          label: "Open issue #34",
          href: "https://github.com/lennons301/lemons/issues/34",
        },
      },
    ]);
  });

  it("drops an exhausted ticket once a newer run re-claims the same issue", () => {
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1" })],
        runs: [
          makeRun({
            id: "r1",
            projectId: "p1",
            attempt: 3,
            status: "exhausted",
            claimedAt: new Date(2026, 6, 30, 9, 0, 0),
            finishedAt: new Date(2026, 6, 30, 10, 0, 0),
          }),
          makeRun({ id: "r2", projectId: "p1", status: "implementing" }),
        ],
      })
    );

    expect(view.needsYou).toEqual([]);
  });

  it("drops an exhausted ticket that fell out of the 7-day window", () => {
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1" })],
        runs: [
          makeRun({
            id: "r1",
            projectId: "p1",
            attempt: 3,
            status: "exhausted",
            claimedAt: new Date(2026, 6, 24, 9, 0, 0),
            finishedAt: new Date(2026, 6, 24, 9, 0, 0), // 8 days before NOW
          }),
        ],
      })
    );

    expect(view.needsYou).toEqual([]);
  });

  it("raises a cap pause card when today's spend reaches the cap", () => {
    const view = buildFleetView(
      baseRows({
        dailyCapUsd: 500,
        runs: [makeRun({ id: "r1", totalCostUsd: 512.34, status: "merged", finishedAt: TODAY_9AM })],
      })
    );

    expect(view.needsYou).toEqual([
      {
        cause: "cap",
        severity: "red",
        context: "$512.34 / $500.00 today",
        body: "Autonomous pickup paused until midnight — interactive work unaffected",
        action: null,
      },
    ]);
  });

  it("raises failed preflight only for autonomy-enabled projects", () => {
    const view = buildFleetView(
      baseRows({
        projects: [
          makeProject({
            id: "p1",
            name: "lemons",
            autonomyEnabled: true,
            preflightStatus: "failing",
            preflightReason: "reviewer is not a collaborator",
          }),
          makeProject({
            id: "p2",
            name: "dormant",
            autonomyEnabled: false,
            preflightStatus: "failing",
            preflightReason: "GitHub App not installed",
          }),
        ],
      })
    );

    expect(view.needsYou).toEqual([
      {
        cause: "preflight",
        severity: "amber",
        context: "lemons",
        body: "Preflight failing: reviewer is not a collaborator",
        action: { label: "Open settings", href: "/settings" },
      },
    ]);
  });

  it("orders causes: cap, blocked, sign-off, exhausted, preflight", () => {
    const view = buildFleetView(
      baseRows({
        dailyCapUsd: 10,
        projects: [
          makeProject({
            id: "p1",
            autonomyEnabled: true,
            preflightStatus: "failing",
            preflightReason: "no branch protection",
          }),
        ],
        runs: [
          makeRun({
            id: "r-exhausted",
            projectId: "p1",
            githubIssue: "o/r#1",
            status: "exhausted",
            attempt: 3,
            finishedAt: TODAY_9AM,
            totalCostUsd: 10,
          }),
          makeRun({
            id: "r-gated",
            projectId: "p1",
            githubIssue: "o/r#2",
            status: "gated",
            pullRequestNumber: 9,
            pullRequestUrl: "https://github.com/o/r/pull/9",
          }),
          makeRun({
            id: "r-blocked",
            projectId: "p1",
            githubIssue: "o/r#3",
            status: "blocked",
            blockedQuestion: "?",
          }),
        ],
      })
    );

    expect(view.needsYou.map((item) => item.cause)).toEqual([
      "cap",
      "blocked",
      "signoff",
      "exhausted",
      "preflight",
    ]);
  });
});

describe("buildFleetView — running", () => {
  it("shows an active run with ticket, attempt, turns, spend vs budget, phase and mode", () => {
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1", name: "lemons" })],
        runs: [
          makeRun({
            id: "r1",
            projectId: "p1",
            attempt: 2,
            status: "implementing",
            totalCostUsd: 7.8,
            budgetUsd: 20,
          }),
        ],
        tasks: [
          makeTask({
            id: "t1",
            projectId: "p1",
            runId: "r1",
            kind: "implement",
            title: "Add pagination to the list",
            containerStatus: "running",
            turns: 4,
          }),
        ],
      })
    );

    expect(view.running).toEqual([
      {
        taskId: "t1",
        runId: "r1",
        projectName: "lemons",
        ticket: "#34",
        title: "Add pagination to the list",
        mode: "afk",
        phases: [
          { name: "implement", state: "current" },
          { name: "review", state: "todo" },
          { name: "merge", state: "todo" },
        ],
        attempt: { current: 2, max: 3 },
        turns: 4,
        startedAt: TODAY_9AM.toISOString(),
        spend: { usd: 7.8, budgetUsd: 20 },
      },
    ]);
  });

  it("lights the review stage and strikes implement when a run is reviewing", () => {
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1" })],
        runs: [makeRun({ id: "r1", projectId: "p1", status: "reviewing" })],
      })
    );

    expect(view.running[0].phases).toEqual([
      { name: "implement", state: "done" },
      { name: "review", state: "current" },
      { name: "merge", state: "todo" },
    ]);
    expect(view.running[0].mode).toBe("afk");
  });

  it("marks a supervised run's mode chip", () => {
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1" })],
        runs: [makeRun({ id: "r1", projectId: "p1", mode: "supervised" })],
      })
    );

    expect(view.running[0].mode).toBe("supervised");
  });

  it("shows an interactive session as a quiet, unbudgeted card", () => {
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1", name: "interlude" })],
        tasks: [
          makeTask({
            id: "t1",
            projectId: "p1",
            title: "Polish the header",
            containerStatus: "idle",
            totalCostUsd: 1.23,
            turns: 3,
            createdAt: TODAY_9AM,
          }),
        ],
      })
    );

    expect(view.running).toEqual([
      {
        taskId: "t1",
        runId: null,
        projectName: "interlude",
        ticket: null,
        title: "Polish the header",
        mode: "interactive",
        phases: null,
        attempt: null,
        turns: 3,
        startedAt: TODAY_9AM.toISOString(),
        spend: { usd: 1.23, budgetUsd: null },
      },
    ]);
  });

  it("picks a run's live pass as its face, ignoring a finished pass with a stale container_status", () => {
    // Issue #46, sibling path: currentTaskOf must not surface a terminal task
    // as a run's current face just because it still carries container_status.
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1", name: "lemons" })],
        runs: [makeRun({ id: "r1", projectId: "p1", status: "reviewing" })],
        tasks: [
          // Ordered first, so a naive `.find` would return it.
          makeTask({
            id: "t-stale",
            projectId: "p1",
            runId: "r1",
            kind: "implement",
            title: "Old finished pass",
            status: "completed",
            containerStatus: "idle",
            createdAt: new Date(2026, 7, 1, 8, 0, 0),
          }),
          makeTask({
            id: "t-live",
            projectId: "p1",
            runId: "r1",
            kind: "review",
            title: "Live review pass",
            status: "running",
            containerStatus: "running",
            createdAt: TODAY_9AM,
          }),
        ],
      })
    );

    expect(view.running).toHaveLength(1);
    expect(view.running[0].taskId).toBe("t-live");
    expect(view.running[0].title).toBe("Live review pass");
  });

  it("excludes finished runs and containerless interactive tasks from running", () => {
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1" })],
        runs: [
          makeRun({ id: "r1", projectId: "p1", status: "merged", finishedAt: TODAY_9AM }),
          makeRun({ id: "r2", projectId: "p1", status: "gated" }),
        ],
        tasks: [
          makeTask({ id: "t1", projectId: "p1", status: "completed", containerStatus: null }),
        ],
      })
    );

    expect(view.running).toEqual([]);
  });
});

describe("buildFleetView — recent completions", () => {
  it("windows completions to 7 days, newest first, with a week total", () => {
    const JUST_INSIDE = new Date(2026, 6, 25, 13, 0, 0); // 6d23h before NOW
    const JUST_OUTSIDE = new Date(2026, 6, 25, 11, 0, 0); // 7d1h before NOW

    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1", name: "lemons" })],
        runs: [
          makeRun({
            id: "r-old",
            projectId: "p1",
            githubIssue: "o/r#1",
            status: "merged",
            totalCostUsd: 9,
            claimedAt: JUST_OUTSIDE,
            finishedAt: JUST_OUTSIDE,
          }),
          makeRun({
            id: "r-week",
            projectId: "p1",
            githubIssue: "o/r#2",
            status: "merged",
            totalCostUsd: 11.5,
            claimedAt: JUST_INSIDE,
            finishedAt: JUST_INSIDE,
            pullRequestNumber: 41,
            pullRequestUrl: "https://github.com/o/r/pull/41",
          }),
          makeRun({
            id: "r-today",
            projectId: "p1",
            githubIssue: "o/r#3",
            status: "failed",
            totalCostUsd: 4.25,
            finishedAt: TODAY_9AM,
          }),
        ],
      })
    );

    expect(view.recent.windowDays).toBe(7);
    expect(view.recent.totalUsd).toBeCloseTo(15.75);
    expect(view.recent.items.map((i) => i.outcome)).toEqual([
      "failed",
      "merged",
    ]);
    expect(view.recent.items[1]).toMatchObject({
      projectName: "lemons",
      costUsd: 11.5,
      finishedAt: JUST_INSIDE.toISOString(),
      prNumber: 41,
      prUrl: "https://github.com/o/r/pull/41",
    });
  });

  it("includes completed interactive tasks but not tasks owned by runs", () => {
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1", name: "interlude" })],
        runs: [
          makeRun({
            id: "r1",
            projectId: "p1",
            status: "merged",
            totalCostUsd: 6,
            finishedAt: TODAY_9AM,
          }),
        ],
        tasks: [
          makeTask({
            id: "t-owned",
            projectId: "p1",
            runId: "r1",
            kind: "implement",
            title: "Ticket work",
            status: "completed",
            containerStatus: null,
            totalCostUsd: 6,
            updatedAt: TODAY_9AM,
          }),
          makeTask({
            id: "t-chat",
            projectId: "p1",
            title: "Sofa session",
            status: "completed",
            containerStatus: null,
            totalCostUsd: 2.5,
            updatedAt: TODAY_9AM,
            pullRequestNumber: 12,
            pullRequestUrl: "https://github.com/o/r/pull/12",
          }),
        ],
      })
    );

    expect(view.recent.items).toHaveLength(2);
    expect(view.recent.items.map((i) => i.title).sort()).toEqual([
      "Sofa session",
      "Ticket work",
    ]);
    expect(view.recent.totalUsd).toBeCloseTo(8.5);
  });

  it("leaves cancelled work out of the ledger", () => {
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1" })],
        runs: [
          makeRun({ id: "r1", projectId: "p1", status: "cancelled", finishedAt: TODAY_9AM }),
        ],
        tasks: [
          makeTask({
            id: "t1",
            projectId: "p1",
            status: "cancelled",
            containerStatus: null,
            updatedAt: TODAY_9AM,
          }),
        ],
      })
    );

    expect(view.recent.items).toEqual([]);
  });
});

describe("buildFleetView — queue and autonomy", () => {
  it("derives total and per-project backlog from the tracker observation", () => {
    const view = buildFleetView(
      baseRows({
        // "ghost" was observed but its project has since been deleted —
        // it must not haunt the total or the breakdown
        backlogByProject: { p1: 2, p2: 0, ghost: 4 },
        projects: [
          makeProject({ id: "p1", name: "interlude", autonomyEnabled: false }),
          makeProject({ id: "p2", name: "lemons", autonomyEnabled: true }),
        ],
      })
    );

    expect(view.queue.readyForAgent).toBe(2);
    expect(view.queue.byProject).toEqual([
      { projectName: "interlude", count: 2 },
      { projectName: "lemons", count: 0 },
    ]);
    expect(view.autonomyOn).toBe(true);
  });

  it("orders the backlog breakdown deepest first, then by name", () => {
    const view = buildFleetView(
      baseRows({
        backlogByProject: { p1: 1, p2: 3, p3: 3 },
        projects: [
          makeProject({ id: "p1", name: "aardvark" }),
          makeProject({ id: "p2", name: "zebra" }),
          makeProject({ id: "p3", name: "lemons" }),
        ],
      })
    );

    expect(view.queue.byProject?.map((b) => b.projectName)).toEqual([
      "lemons",
      "zebra",
      "aardvark",
    ]);
  });

  it("reports unknown queue depth as null and autonomy off", () => {
    const view = buildFleetView(baseRows());

    expect(view.queue.readyForAgent).toBeNull();
    expect(view.queue.byProject).toBeNull();
    expect(view.autonomyOn).toBe(false);
  });
});
