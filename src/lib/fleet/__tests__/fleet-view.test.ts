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
    readyForAgentCount: null,
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
