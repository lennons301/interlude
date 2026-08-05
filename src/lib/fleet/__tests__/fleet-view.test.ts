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
    reviewVerdict: null,
    reviewResult: null,
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

  it("raises a gated PR waiting for human sign-off once its review approves", () => {
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1", name: "lemons" })],
        runs: [
          makeRun({
            id: "r1",
            projectId: "p1",
            status: "gated",
            // The review has landed as approve — the PR is one human merge away.
            reviewVerdict: "approve",
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

  it("does not raise a gated PR whose review is still in flight (issue #90)", () => {
    // The premature-firing bug: a gated run with no verdict yet was flagged as
    // a sign-off wait. Until the review lands it is fleet activity, not a
    // needs-you item.
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1", name: "lemons" })],
        runs: [
          makeRun({
            id: "r1",
            projectId: "p1",
            status: "gated",
            reviewVerdict: null,
            reviewResult: null,
            pullRequestNumber: 55,
            pullRequestUrl: "https://github.com/lennons301/lemons/pull/55",
          }),
        ],
        tasks: [
          makeTask({
            id: "t-review",
            projectId: "p1",
            runId: "r1",
            kind: "review",
            title: "Review PR #55: Add auth",
            status: "running",
            containerStatus: "running",
          }),
        ],
      })
    );

    expect(view.needsYou).toEqual([]);
    // It reads as fleet activity instead, under Running.
    expect(view.running.map((c) => c.runId)).toEqual(["r1"]);
  });

  it("raises a gated PR whose reviewer escalated for sign-off", () => {
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1", name: "lemons" })],
        runs: [
          makeRun({
            id: "r1",
            projectId: "p1",
            status: "gated",
            reviewVerdict: "escalate",
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
        body: "PR #55 — the reviewer escalated for your sign-off",
        action: {
          label: "Review PR #55",
          href: "https://github.com/lennons301/lemons/pull/55",
        },
      },
    ]);
  });

  it("raises a run parked by an unparseable review verdict as its own cause (issue #90)", () => {
    // Terminal by design: the review pass finished but its verdict could not
    // be read, so the run is parked for a human. Distinct from a happy sign-off
    // wait — it must not sit in `signoff` indistinguishable from one.
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1", name: "lemons" })],
        runs: [
          makeRun({
            id: "r1",
            projectId: "p1",
            status: "gated",
            reviewVerdict: null,
            reviewResult: {
              kind: "unparseable",
              reason: "final message does not start with a VERDICT: line",
            },
            pullRequestNumber: 55,
            pullRequestUrl: "https://github.com/lennons301/lemons/pull/55",
          }),
        ],
      })
    );

    expect(view.needsYou).toEqual([
      {
        cause: "unparseable",
        severity: "red",
        context: "lemons #34 · attempt 1/3",
        body: "Review verdict couldn't be read on PR #55 — parked, nothing merges until you look",
        action: {
          label: "Open PR #55",
          href: "https://github.com/lennons301/lemons/pull/55",
        },
      },
    ]);
    // A parked run is not running — its review is over, not in flight.
    expect(view.running).toEqual([]);
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
    // A successful repair resets integrationCount to 0, so an approved run
    // reads as a clean sign-off wait, not a conflict.
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1", name: "lemons" })],
        runs: [
          makeRun({
            id: "r1",
            projectId: "p1",
            status: "gated",
            integrationCount: 0,
            reviewVerdict: "approve",
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
            reviewVerdict: "approve",
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
    // Issue #46, sibling path: currentPassOf must not surface a terminal task
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

  it("keeps a reviewing run's card on its review pass after the review container is gone (issue #96)", () => {
    // Symptom 1: the review pass has completed (terminal task.status, container
    // torn down) but the run is still `reviewing` until the next sweep posts the
    // verdict, and the implement pass sits parked running/idle beside it. The
    // card must point at the review task, not the finished implement pass.
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1", name: "lemons" })],
        runs: [makeRun({ id: "r1", projectId: "p1", status: "reviewing" })],
        tasks: [
          makeTask({
            id: "t-impl",
            projectId: "p1",
            runId: "r1",
            kind: "implement",
            title: "Add auth",
            status: "running",
            containerStatus: "idle",
            createdAt: new Date(2026, 7, 1, 9, 0, 0),
          }),
          makeTask({
            id: "t-review",
            projectId: "p1",
            runId: "r1",
            kind: "review",
            title: "Review PR #55: Add auth",
            status: "completed",
            containerStatus: null,
            createdAt: new Date(2026, 7, 1, 9, 30, 0),
          }),
        ],
      })
    );

    expect(view.running).toHaveLength(1);
    expect(view.running[0].taskId).toBe("t-review");
    expect(view.running[0].title).toBe("Review PR #55: Add auth");
  });

  it("resolves a reviewing run's face by phase, not by a stale busy implement (issue #96)", () => {
    // An ungraceful death can leave the implement pass at running/running
    // instead of parked idle. Selecting purely by container-busyness would pick
    // that stale implement; selecting within the run's phase (review) picks the
    // review pass even while its own container is momentarily idle between turns.
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1", name: "lemons" })],
        runs: [makeRun({ id: "r1", projectId: "p1", status: "reviewing" })],
        tasks: [
          makeTask({
            id: "t-impl",
            projectId: "p1",
            runId: "r1",
            kind: "implement",
            status: "running",
            containerStatus: "running", // stale — never parked to idle
            createdAt: new Date(2026, 7, 1, 9, 0, 0),
          }),
          makeTask({
            id: "t-review",
            projectId: "p1",
            runId: "r1",
            kind: "review",
            title: "Review PR #55",
            status: "running",
            containerStatus: "idle", // between review turns
            createdAt: new Date(2026, 7, 1, 9, 30, 0),
          }),
        ],
      })
    );

    expect(view.running[0].taskId).toBe("t-review");
  });

  it("resolves duplicate review passes to the one actually running (issue #95)", () => {
    // Two review passes on one run (issue #95): the card links to the container
    // that is really executing, not the dead earlier attempt.
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1", name: "lemons" })],
        runs: [makeRun({ id: "r1", projectId: "p1", status: "reviewing" })],
        tasks: [
          makeTask({
            id: "t-review-old",
            projectId: "p1",
            runId: "r1",
            kind: "review",
            status: "failed",
            containerStatus: null,
            createdAt: new Date(2026, 7, 1, 9, 0, 0),
          }),
          makeTask({
            id: "t-review-live",
            projectId: "p1",
            runId: "r1",
            kind: "review",
            title: "Review PR #55 (retry)",
            status: "running",
            containerStatus: "running",
            createdAt: new Date(2026, 7, 1, 9, 30, 0),
          }),
        ],
      })
    );

    expect(view.running[0].taskId).toBe("t-review-live");
  });

  it("does not link a reviewing run to the parked implement before its review pass exists (issue #96)", () => {
    // The status flips to `reviewing` a sweep before the review pass is queued.
    // In that window the card must not fall back to the parked implement — it
    // shows as a non-clickable review card until the review task appears, rather
    // than deep-linking to the finished implement task (the exact symptom 1).
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1", name: "lemons" })],
        runs: [makeRun({ id: "r1", projectId: "p1", status: "reviewing" })],
        tasks: [
          makeTask({
            id: "t-impl",
            projectId: "p1",
            runId: "r1",
            kind: "implement",
            title: "Add auth",
            status: "running",
            containerStatus: "idle",
          }),
        ],
      })
    );

    expect(view.running).toHaveLength(1);
    expect(view.running[0].runId).toBe("r1");
    expect(view.running[0].taskId).toBeNull();
  });

  it("surfaces a gated run under review as fleet activity with the review pass's spend (issue #90)", () => {
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1", name: "lemons" })],
        runs: [
          makeRun({
            id: "r1",
            projectId: "p1",
            status: "gated",
            reviewVerdict: null,
            reviewResult: null,
            totalCostUsd: 9.5, // implement + review, rolled up on the run
            budgetUsd: 20,
          }),
        ],
        tasks: [
          // The implement pass, parked idle awaiting a possible fix-up...
          makeTask({
            id: "t-impl",
            projectId: "p1",
            runId: "r1",
            kind: "implement",
            title: "Add auth",
            status: "running",
            containerStatus: "idle",
            totalCostUsd: 7.4,
            createdAt: new Date(2026, 7, 1, 9, 0, 0),
          }),
          // ...while the review pass actively runs.
          makeTask({
            id: "t-review",
            projectId: "p1",
            runId: "r1",
            kind: "review",
            title: "Review PR #55: Add auth",
            status: "running",
            containerStatus: "running",
            totalCostUsd: 2.1,
            turns: 1,
            createdAt: new Date(2026, 7, 1, 9, 30, 0),
          }),
        ],
      })
    );

    expect(view.needsYou).toEqual([]);
    expect(view.running).toHaveLength(1);
    expect(view.running[0]).toMatchObject({
      taskId: "t-review",
      runId: "r1",
      title: "Review PR #55: Add auth",
      mode: "afk",
      phases: [
        { name: "implement", state: "done" },
        { name: "review", state: "current" },
        { name: "merge", state: "todo" },
      ],
      turns: 1,
      // The review pass's own spend against the review budget — not the run's
      // rolled-up spend against the $20 attempt budget.
      spend: { usd: 2.1, budgetUsd: 5 },
    });
  });

  it("surfaces a triage pass as its own kind of fleet activity (issue #90)", () => {
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1", name: "lemons" })],
        tasks: [
          makeTask({
            id: "t-triage",
            projectId: "p1",
            runId: null,
            kind: "triage",
            title: "Triage: Add auth",
            status: "running",
            containerStatus: "running",
            totalCostUsd: 0.8,
            turns: 1,
            githubIssue: "lennons301/lemons#90",
            createdAt: TODAY_9AM,
          }),
        ],
      })
    );

    expect(view.running).toEqual([
      {
        taskId: "t-triage",
        runId: null,
        projectName: "lemons",
        ticket: "#90",
        title: "Triage: Add auth",
        mode: "triage",
        phases: null,
        attempt: null,
        turns: 1,
        startedAt: TODAY_9AM.toISOString(),
        spend: { usd: 0.8, budgetUsd: 2 },
      },
    ]);
  });

  it("excludes finished runs and gated runs with no live pass from running", () => {
    // A merged run is done; a gated run with no live container is either
    // between sweeps or already resolved (a landed verdict routes it to
    // needs-you), so neither reads as fleet activity.
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
