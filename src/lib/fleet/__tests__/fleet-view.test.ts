import { describe, it, expect } from "vitest";
import {
  buildFleetView,
  type FleetRows,
  type FleetProjectRow,
  type FleetRunRow,
  type FleetTaskRow,
} from "../fleet-view";
import { RESUME_JITTER_WINDOW_MS } from "../../orchestrator/autonomy/budgets";
import { resumeEligibleAt } from "../../orchestrator/autonomy/resume-jitter";

// Fixed clock: noon local time, so "today" and the 7-day window are unambiguous
const NOW = new Date(2026, 7, 1, 12, 0, 0);
const TODAY_9AM = new Date(2026, 7, 1, 9, 0, 0);

function baseRows(overrides: Partial<FleetRows> = {}): FleetRows {
  return {
    now: NOW,
    slots: 2,
    dailyCapUsd: 500,
    // The money guards (issue #174) idle by default: a subscription lane, so
    // nothing here costs cash and the guards decide nothing.
    meteredCapUsd: 20,
    meteredSpendTodayUsd: 0,
    primaryLaneId: "claude-subscription",
    primaryLaneBilling: "subscription",
    primaryLaneOverage: false,
    meteredSpendConfirmedAt: null,
    globalAutonomyPaused: false,
    // The boot master on, so every test that doesn't say otherwise describes an
    // install where autonomy is actually armed at boot (issue #148).
    autonomyEnabledAtBoot: true,
    discordGuildId: null,
    projects: [],
    runs: [],
    tasks: [],
    backlogByProject: null,
    needsHumanByProject: null,
    fleetHealth: null,
    failingChecksByRun: null,
    quota: null,
    quotaLane: null,
    quotaThresholdPercent: 90,
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
    ciRepairCount: 0,
    reviewVerdict: null,
    reviewResult: null,
    resumeAfter: null,
    model: null,
    degradedFrom: null,
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
    sessionSkill: null,
    sessionIssue: null,
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

/**
 * The real-money split (issue #174). It is a different number from the one
 * above and answers to different rules: it comes from the per-day ledger, not
 * from anything derived here, and nothing is exempt by kind — a chat session
 * on a metered lane charges the same card an implement pass does.
 */
describe("buildFleetView — metered spend", () => {
  const METERED = { primaryLaneId: "openrouter", primaryLaneBilling: "metered" as const };

  it("shows nothing metered while the fleet runs on a subscription lane", () => {
    const view = buildFleetView(
      baseRows({
        projects: [makeProject()],
        runs: [makeRun({ id: "r1", totalCostUsd: 9 })],
      })
    );

    expect(view.spend.metered.active).toBe(false);
    expect(view.spend.metered.todayUsd).toBe(0);
    // The autonomous gauge is untouched by any of this.
    expect(view.spend.todayUsd).toBeCloseTo(9);
  });

  it("reports the day's cash beside the autonomous figure, never folded into it", () => {
    const view = buildFleetView(
      baseRows({
        ...METERED,
        meteredSpendTodayUsd: 10,
        meteredSpendConfirmedAt: TODAY_9AM,
        projects: [makeProject()],
        runs: [makeRun({ id: "r1", totalCostUsd: 6 })],
      })
    );

    expect(view.spend.metered.todayUsd).toBeCloseTo(10);
    expect(view.spend.metered.active).toBe(true);
    expect(view.spend.metered.laneId).toBe("openrouter");
    expect(view.spend.metered.hold).toBeNull();
    // The two overlap by construction and are deliberately not added.
    expect(view.spend.todayUsd).toBeCloseTo(6);
  });

  it("still reports cash spent today after a switch back to a subscription lane", () => {
    const view = buildFleetView(
      baseRows({ meteredSpendTodayUsd: 7, projects: [makeProject()] })
    );

    expect(view.spend.metered.active).toBe(false);
    expect(view.spend.metered.todayUsd).toBeCloseTo(7);
    // Nothing more will be spent, so nothing is held.
    expect(view.spend.metered.hold).toBeNull();
  });

  it("holds and says so when the cash cap is spent", () => {
    const view = buildFleetView(
      baseRows({
        ...METERED,
        meteredCapUsd: 20,
        meteredSpendTodayUsd: 20,
        meteredSpendConfirmedAt: TODAY_9AM,
        projects: [makeProject()],
      })
    );

    expect(view.spend.metered.capPaused).toBe(true);
    expect(view.pickupPaused).toEqual({
      reason: "metered-cap",
      body: expect.stringContaining("openrouter"),
    });
    expect(view.needsYou.map((i) => i.cause)).toContain("metered-cap");
  });

  it("holds for the day's one confirmation, pointing at the press that lifts it", () => {
    const view = buildFleetView(
      baseRows({ ...METERED, meteredSpendConfirmedAt: null, projects: [makeProject()] })
    );

    expect(view.pickupPaused?.reason).toBe("metered-unconfirmed");
    const card = view.needsYou.find((i) => i.cause === "metered-confirm");
    expect(card?.action).toEqual({ label: "Settings", href: "/settings" });
  });

  it("treats yesterday's confirmation as none", () => {
    const view = buildFleetView(
      baseRows({
        ...METERED,
        meteredSpendConfirmedAt: new Date(2026, 6, 31, 23, 59, 0),
        projects: [makeProject()],
      })
    );

    expect(view.spend.metered.confirmed).toBe(false);
    expect(view.pickupPaused?.reason).toBe("metered-unconfirmed");
  });

  it("lets the kill switch outrank a money hold on the banner", () => {
    // Both hold; the switch is the one a human threw and can lift, so naming
    // the money guard would send them to the wrong control.
    const view = buildFleetView(
      baseRows({
        ...METERED,
        globalAutonomyPaused: true,
        meteredSpendConfirmedAt: null,
        projects: [makeProject()],
      })
    );

    expect(view.pickupPaused?.reason).toBe("kill-switch");
    // The money hold keeps its own surfaces regardless of being outranked.
    expect(view.spend.metered.hold).toBe("unconfirmed");
    expect(view.needsYou.map((i) => i.cause)).toContain("metered-confirm");
  });
});

// The live dot + banner surface (issues #118, #148): a held fleet must never
// read as an idle one, and the three ways pickup can be held are lifted in
// three different ways.
describe("buildFleetView — why pickup is paused", () => {
  it("reports nothing while pickup runs", () => {
    expect(buildFleetView(baseRows()).pickupPaused).toBeNull();
  });

  it("names the boot master when autonomy is off at boot", () => {
    const view = buildFleetView(baseRows({ autonomyEnabledAtBoot: false }));

    expect(view.pickupPaused?.reason).toBe("autonomy-off-at-boot");
    expect(view.pickupPaused?.body).toMatch(/AUTONOMY_ENABLED/);
    // Not the switch's wording: pressing that control would change nothing
    expect(view.pickupPaused?.body).not.toMatch(/kill switch engaged/i);
  });

  it("names the kill switch when it is engaged", () => {
    const view = buildFleetView(baseRows({ globalAutonomyPaused: true }));

    expect(view.pickupPaused?.reason).toBe("kill-switch");
    expect(view.pickupPaused?.body).toMatch(/kill switch/i);
    // The switch spends nothing, so the cap's own gauge is untouched
    expect(view.spend.capPaused).toBe(false);
  });

  it("names the daily cap when the cap is what stopped pickup", () => {
    const view = buildFleetView(
      baseRows({ runs: [makeRun({ id: "r1", totalCostUsd: 500 })] })
    );

    expect(view.pickupPaused?.reason).toBe("daily-cap");
    expect(view.pickupPaused?.body).toMatch(/midnight/i);
  });

  it("names the boot master ahead of both runtime holds", () => {
    // With no sweep running at all, sending the owner to lift the kill switch
    // would be a remedy that does nothing — so the master leads.
    const view = buildFleetView(
      baseRows({
        autonomyEnabledAtBoot: false,
        globalAutonomyPaused: true,
        runs: [makeRun({ id: "r1", totalCostUsd: 512 })],
      })
    );

    expect(view.pickupPaused?.reason).toBe("autonomy-off-at-boot");
    // Everything the other holds own is untouched by being outranked
    expect(view.spend.capPaused).toBe(true);
    expect(view.needsYou.map((i) => i.cause)).toContain("cap");
  });

  it("stays fleet-wide: a failing preflight on one project holds nothing here", () => {
    // Six armed projects, one failing preflight, is not a held fleet — that
    // would over-claim. It is said per project instead (issue #148).
    const view = buildFleetView(
      baseRows({
        projects: [
          makeProject({ id: "p1", name: "lemons", autonomyEnabled: true, preflightStatus: "passing" }),
          makeProject({
            id: "p2",
            name: "moontide",
            autonomyEnabled: true,
            preflightStatus: "failing",
            preflightReason: "no branch protection",
          }),
        ],
      })
    );

    expect(view.pickupPaused).toBeNull();
    expect(view.needsYou.map((i) => i.cause)).toEqual(["preflight"]);
  });

  it("names the kill switch ahead of the cap when both hold", () => {
    // Midnight lifts the cap; only a human lifts the switch, so the switch is
    // the thing the owner needs to read.
    const view = buildFleetView(
      baseRows({
        globalAutonomyPaused: true,
        runs: [makeRun({ id: "r1", totalCostUsd: 512 })],
      })
    );

    expect(view.pickupPaused?.reason).toBe("kill-switch");
    expect(view.spend.capPaused).toBe(true);
    // The cap still raises its own needs-you card — the switch hides nothing
    expect(view.needsYou.map((i) => i.cause)).toContain("cap");
  });

  // The quota admission gate (issue #171). The banner reads the same pure gate
  // `decideNext` refuses pickup with, against the same threshold, because the
  // two surfaces disagreeing about whether work is being claimed is exactly
  // the confusion this field exists to remove.
  describe("the quota gate", () => {
    const walled = (
      overrides: Partial<NonNullable<FleetRows["quota"]>> = {}
    ): NonNullable<FleetRows["quota"]> => ({
      status: "allowed_warning",
      rateLimitType: "five_hour",
      utilization: 94,
      resetsAt: new Date(NOW.getTime() + 60 * 60_000),
      overageStatus: null,
      overageResetsAt: null,
      isUsingOverage: null,
      overageInUse: null,
      observedAt: new Date(NOW.getTime() - 60_000),
      ...overrides,
    });

    it("names the quota gate, with both numbers, when the window is nearly spent", () => {
      const view = buildFleetView(baseRows({ quota: walled() }));

      expect(view.pickupPaused?.reason).toBe("quota-gate");
      expect(view.pickupPaused?.body).toContain("94%");
      expect(view.pickupPaused?.body).toContain("90%");
      expect(view.pickupPaused?.body).toMatch(/5-hour window/);
      // What is *not* held is the other half of the answer
      expect(view.pickupPaused?.body).toMatch(/in flight continues/i);
    });

    it("words an outright rejection as the wall it is", () => {
      const view = buildFleetView(
        baseRows({ quota: walled({ status: "rejected", utilization: null }) })
      );

      expect(view.pickupPaused?.reason).toBe("quota-gate");
      expect(view.pickupPaused?.body).toMatch(/being rejected/i);
    });

    it("holds nothing once the observed window has reset", () => {
      const view = buildFleetView(
        baseRows({
          quota: walled({ resetsAt: new Date(NOW.getTime() - 1) }),
        })
      );

      expect(view.pickupPaused).toBeNull();
    });

    it("follows the threshold in force, not a compiled-in one", () => {
      expect(
        buildFleetView(
          baseRows({ quota: walled(), quotaThresholdPercent: 95 })
        ).pickupPaused
      ).toBeNull();
    });

    it("names the cap ahead of the gate when both hold", () => {
      // Of the two self-lifting holds, the cap's ceiling is the one a human
      // chose. The Quota tile keeps saying its own piece either way.
      const view = buildFleetView(
        baseRows({
          quota: walled(),
          runs: [makeRun({ id: "r1", totalCostUsd: 512 })],
        })
      );

      expect(view.pickupPaused?.reason).toBe("daily-cap");
      expect(view.quota?.utilization).toBe(94);
    });
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
              reason: "final message has no VERDICT: line",
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

  it("raises a gated PR whose checks still fail, naming them (issue #130)", () => {
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1", name: "lemons" })],
        runs: [
          makeRun({
            id: "r1",
            projectId: "p1",
            status: "gated",
            // CI repairs spent (MAX_CI_REPAIR_ATTEMPTS = 1), rollup still red
            ciRepairCount: 1,
            reviewVerdict: "approve",
            pullRequestNumber: 55,
            pullRequestUrl: "https://github.com/lennons301/lemons/pull/55",
          }),
        ],
        failingChecksByRun: { r1: ["Type Check", "vercel"] },
      })
    );

    expect(view.needsYou).toEqual([
      {
        cause: "checks-failing",
        severity: "red",
        context: "lemons #34 · attempt 1/3",
        body: "PR #55 checks still failing after an automated repair: Type Check, vercel",
        action: {
          label: "Open PR #55",
          href: "https://github.com/lennons301/lemons/pull/55",
        },
      },
    ]);
  });

  it("summarises the tail when many checks fail at once", () => {
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1", name: "lemons" })],
        runs: [
          makeRun({
            id: "r1",
            projectId: "p1",
            status: "gated",
            ciRepairCount: 1,
            pullRequestNumber: 55,
            pullRequestUrl: "https://github.com/lennons301/lemons/pull/55",
          }),
        ],
        failingChecksByRun: { r1: ["Type Check", "Lint", "Test", "vercel", "e2e"] },
      })
    );

    expect(view.needsYou[0].body).toBe(
      "PR #55 checks still failing after an automated repair: Type Check, Lint, Test +2 more"
    );
  });

  it("does not raise failing checks while the rollup is no longer observed red", () => {
    // The window after a CI repair pushes: the counter is spent but the new
    // head's rollup is pending, so nothing is owed to a human yet.
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1", name: "lemons" })],
        runs: [
          makeRun({
            id: "r1",
            projectId: "p1",
            status: "gated",
            ciRepairCount: 1,
            reviewVerdict: "approve",
            pullRequestNumber: 55,
            pullRequestUrl: "https://github.com/lennons301/lemons/pull/55",
          }),
        ],
        failingChecksByRun: {},
      })
    );

    expect(view.needsYou.map((i) => i.cause)).toEqual(["signoff"]);
  });

  it("keeps a merge conflict ahead of failing checks when a run has both", () => {
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1", name: "lemons" })],
        runs: [
          makeRun({
            id: "r1",
            projectId: "p1",
            status: "gated",
            integrationCount: 1,
            ciRepairCount: 1,
            pullRequestNumber: 55,
            pullRequestUrl: "https://github.com/lennons301/lemons/pull/55",
          }),
        ],
        failingChecksByRun: { r1: ["Type Check"] },
      })
    );

    expect(view.needsYou.map((i) => i.cause)).toEqual(["conflict"]);
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

  it("drops an exhausted ticket the tracker shows a human has dealt with", () => {
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1" })],
        runs: [
          makeRun({
            id: "r1",
            projectId: "p1",
            attempt: 3,
            status: "exhausted",
            finishedAt: TODAY_9AM, // still well inside the 7-day window
          }),
        ],
        // p1 was observed and #34 is no longer open + ready-for-human: the
        // human closed it or dropped the label, so it stops needing you even
        // though no newer run exists and the window hasn't elapsed.
        needsHumanByProject: { p1: [] },
      })
    );

    expect(view.needsYou).toEqual([]);
  });

  it("keeps an exhausted ticket still open and ready-for-human on the tracker", () => {
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1" })],
        runs: [
          makeRun({
            id: "r1",
            projectId: "p1",
            attempt: 3,
            status: "exhausted",
            finishedAt: TODAY_9AM,
          }),
        ],
        needsHumanByProject: { p1: ["lennons301/lemons#34"] },
      })
    );

    expect(view.needsYou.map((i) => i.cause)).toEqual(["exhausted"]);
  });

  it("keeps an exhausted ticket when its project was never observed", () => {
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1" })],
        runs: [
          makeRun({
            id: "r1",
            projectId: "p1",
            attempt: 3,
            status: "exhausted",
            finishedAt: TODAY_9AM,
          }),
        ],
        // Another project was observed, but not p1 — absence here is "unknown",
        // not "resolved", so the window remains the only release valve for p1.
        needsHumanByProject: { "other-project": [] },
      })
    );

    expect(view.needsYou.map((i) => i.cause)).toEqual(["exhausted"]);
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

  it("raises failed preflight only for autonomy-enabled projects, and says nothing is picked up there", () => {
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
        body: "Preflight failing, so none of its tickets are picked up: reviewer is not a collaborator",
        action: { label: "Open settings", href: "/settings" },
      },
    ]);
  });

  it("raises a never-run preflight too — the reducer fails closed, so the card does", () => {
    const view = buildFleetView(
      baseRows({
        projects: [
          makeProject({ id: "p1", name: "lemons", autonomyEnabled: true, preflightStatus: null }),
          makeProject({ id: "p2", name: "moontide", autonomyEnabled: true, preflightStatus: "passing" }),
        ],
      })
    );

    expect(view.needsYou).toEqual([
      {
        cause: "preflight",
        severity: "amber",
        context: "lemons",
        body: "Preflight has never run, so none of its tickets are picked up — pickup fails closed until it passes.",
        action: { label: "Open settings", href: "/settings" },
      },
    ]);
  });

  it("orders causes: cap, machinery health, blocked, sign-off, exhausted, preflight", () => {
    const view = buildFleetView(
      baseRows({
        dailyCapUsd: 10,
        fleetHealth: {
          owedReviewStalls: [
            {
              runId: "run-x",
              issueRef: "o/r#5",
              prNumber: 12,
              prUrl: "https://github.com/o/r/pull/12",
              reason: "a slot is held by an interactive session (1/1 busy)",
              stalledForMs: 31 * 60_000,
            },
          ],
          pickupWedged: {
            cause: "dispatch" as const,
            detail: "1 slot free but pickup is paused (no-slots)",
            wedgedForMs: 4 * 60_000,
            remedy: "Check the orchestrator.",
          },
          queueStale: { staleForMs: 3 * 60_000 },
          undeliveredAnswers: [
            {
              taskId: "t-3",
              label: "o/r #3",
              issueRef: "o/r#3",
              taskUrl: "/tasks/t-3",
              queuedAtMs: 0,
              undeliveredForMs: 20 * 60_000,
            },
          ],
        },
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
      "queue-stale",
      "pickup-wedged",
      "answer-undelivered",
      "review-stalled",
      "blocked",
      "signoff",
      "exhausted",
      "preflight",
    ]);
  });
});

describe("buildFleetView — fleet health (#126)", () => {
  it("renders no health cards when the sweep has not evaluated (null)", () => {
    const view = buildFleetView(baseRows({ fleetHealth: null }));
    expect(view.needsYou).toEqual([]);
  });

  it("raises a stale-queue card, red, no action", () => {
    const view = buildFleetView(
      baseRows({
        fleetHealth: {
          owedReviewStalls: [],
          pickupWedged: null,
          queueStale: { staleForMs: 3 * 60_000 },
          undeliveredAnswers: [],
        },
      })
    );
    expect(view.needsYou).toEqual([
      {
        cause: "queue-stale",
        severity: "red",
        context: "queue loop",
        body: "Queue poll loop hasn't made progress for 3m — dispatch is likely wedged",
        action: null,
      },
    ]);
  });

  it("raises a pickup-wedged card carrying the sweep's detail and its remedy", () => {
    const view = buildFleetView(
      baseRows({
        fleetHealth: {
          owedReviewStalls: [],
          pickupWedged: {
            cause: "dispatch" as const,
            detail: '1 slot free but "review: o/r#5" has not dispatched',
            wedgedForMs: 5 * 60_000,
            remedy: "Check the orchestrator (a hung Docker daemon).",
          },
          queueStale: null,
          undeliveredAnswers: [],
        },
      })
    );
    expect(view.needsYou).toEqual([
      {
        cause: "pickup-wedged",
        severity: "red",
        context: "pickup",
        body:
          '1 slot free but "review: o/r#5" has not dispatched for 5m. ' +
          "Check the orchestrator (a hung Docker daemon).",
        action: null,
      },
    ]);
  });

  // Issue #152: the phantom-occupancy card and the ordinary wedge card are the
  // same card — what differs is what it tells the operator to do, and that
  // sentence comes from the evaluator so it cannot drift from the Discord ping.
  it("carries a phantom slot's restart remedy onto the same card", () => {
    const view = buildFleetView(
      baseRows({
        fleetHealth: {
          owedReviewStalls: [],
          pickupWedged: {
            cause: "phantom-slot" as const,
            detail: "occupancy says 1 slot busy but the daemon reports 0 agent containers live",
            wedgedForMs: 12 * 60_000,
            remedy:
              "The slot count is held in orchestrator memory with nothing behind it — restart the app to clear it.",
          },
          queueStale: null,
          undeliveredAnswers: [],
        },
      })
    );
    expect(view.needsYou[0].body).toContain("occupancy says 1 slot busy");
    expect(view.needsYou[0].body).toContain("restart the app");
  });

  it("raises an owed-review-stalled card naming the PR, with a link when known", () => {
    const view = buildFleetView(
      baseRows({
        fleetHealth: {
          owedReviewStalls: [
            {
              runId: "run-1",
              issueRef: "lennons301/last-person-standing#135",
              prNumber: 159,
              prUrl: "https://github.com/lennons301/last-person-standing/pull/159",
              reason: "a slot is held by an interactive session (1/1 busy)",
              stalledForMs: 34 * 60_000,
            },
          ],
          pickupWedged: null,
          queueStale: null,
          undeliveredAnswers: [],
        },
      })
    );
    expect(view.needsYou).toEqual([
      {
        cause: "review-stalled",
        severity: "red",
        context: "last-person-standing #135 · PR #159",
        body: "Review hasn't started for 34m — a slot is held by an interactive session (1/1 busy)",
        action: {
          label: "Open PR #159",
          href: "https://github.com/lennons301/last-person-standing/pull/159",
        },
      },
    ]);
  });

  it("omits the link on a stalled review whose PR URL is unknown", () => {
    const view = buildFleetView(
      baseRows({
        fleetHealth: {
          owedReviewStalls: [
            {
              runId: "run-1",
              issueRef: "o/r#7",
              prNumber: 7,
              prUrl: null,
              reason: "all 2 slots busy",
              stalledForMs: 90 * 60_000,
            },
          ],
          pickupWedged: null,
          queueStale: null,
          undeliveredAnswers: [],
        },
      })
    );
    expect(view.needsYou[0]).toMatchObject({
      cause: "review-stalled",
      body: "Review hasn't started for 1h 30m — all 2 slots busy",
      action: null,
    });
  });

  it("raises one card per stalled review", () => {
    const view = buildFleetView(
      baseRows({
        fleetHealth: {
          owedReviewStalls: [
            { runId: "a", issueRef: "o/r#1", prNumber: 1, prUrl: null, reason: "x", stalledForMs: 31 * 60_000 },
            { runId: "b", issueRef: "o/r#2", prNumber: 2, prUrl: null, reason: "x", stalledForMs: 31 * 60_000 },
          ],
          pickupWedged: null,
          queueStale: null,
          undeliveredAnswers: [],
        },
      })
    );
    expect(view.needsYou.filter((i) => i.cause === "review-stalled")).toHaveLength(2);
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
        sessionSkill: null,
        phases: [
          { name: "implement", state: "current" },
          { name: "review", state: "todo" },
          { name: "merge", state: "todo" },
        ],
        attempt: { current: 2, max: 3 },
        turns: 4,
        startedAt: TODAY_9AM.toISOString(),
        spend: { usd: 7.8, budgetUsd: 20 },
        paused: null,
        degraded: null,
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

  it("shows a quota-paused run in place, with when it resumes (issue #168)", () => {
    // A run walled by the account's quota is still the fleet's work in
    // progress — it holds its ticket and its branch — so it stays on the board
    // rather than vanishing between the wall and the reset. The card carries
    // the clock it is waiting on; the countdown is the client's.
    //
    // The instant is the run's *eligible* one — the reset plus this run's own
    // jitter (issue #169) — read through the same function the reducer decides
    // with, so the countdown cannot hit zero minutes before anything moves.
    const resumeAfter = new Date(2026, 7, 1, 17, 0, 0);
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1" })],
        runs: [
          makeRun({
            id: "r1",
            projectId: "p1",
            status: "rate_limited",
            resumeAfter,
          }),
        ],
      })
    );

    expect(view.running).toHaveLength(1);
    expect(view.running[0]).toMatchObject({
      runId: "r1",
      paused: {
        reason: "rate-limited",
        resumeAfter: resumeEligibleAt(
          "r1",
          resumeAfter,
          RESUME_JITTER_WINDOW_MS
        ).toISOString(),
      },
      // It resumes from where it stopped, which is the implement pass.
      phases: [
        { name: "implement", state: "current" },
        { name: "review", state: "todo" },
        { name: "merge", state: "todo" },
      ],
    });
  });

  it("never puts a quota-paused run in needs-you", () => {
    // The deliberate omission: nobody has to do anything about a quota window,
    // and "needs you" means a human decision is required. A paused run leaking
    // in there would train the owner to ignore the section.
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1" })],
        runs: [
          makeRun({
            id: "r1",
            projectId: "p1",
            status: "rate_limited",
            resumeAfter: new Date(2026, 7, 1, 17, 0, 0),
          }),
        ],
      })
    );

    expect(view.needsYou).toEqual([]);
  });

  it("holds no slot while it is paused", () => {
    // The pause tore the container down (a parked one holds memory without
    // holding a slot — the 2026-08-04 wedge), so the run's task is terminal and
    // occupancy is untouched. A paused card next to a used slot would be the
    // dashboard reporting a container that no longer exists.
    const view = buildFleetView(
      baseRows({
        slots: 2,
        projects: [makeProject({ id: "p1" })],
        runs: [
          makeRun({
            id: "r1",
            projectId: "p1",
            status: "rate_limited",
            resumeAfter: new Date(2026, 7, 1, 17, 0, 0),
          }),
        ],
        tasks: [
          makeTask({
            id: "t1",
            projectId: "p1",
            runId: "r1",
            kind: "implement",
            status: "failed",
            containerStatus: null,
          }),
        ],
      })
    );

    expect(view.running).toHaveLength(1);
    expect(view.slots.used).toBe(0);
  });

  it("shows no pause on a rate-limited row carrying no reset time", () => {
    // Defensive: a row that says it is paused but names no clock is a run
    // waiting on nothing, and the card refuses to claim otherwise.
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1" })],
        runs: [makeRun({ id: "r1", projectId: "p1", status: "rate_limited" })],
      })
    );

    expect(view.running[0].paused).toBeNull();
  });

  it("shows a run working below the tier it was asked for (issue #170)", () => {
    // A degraded run is *working*, not waiting: the tier ladder stepped it down
    // and it carried on. The card says so because the result in front of the
    // operator was produced by a cheaper model than the one they chose, which
    // is not recoverable from anywhere else on the screen.
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1" })],
        runs: [
          makeRun({
            id: "r1",
            projectId: "p1",
            status: "implementing",
            model: "light",
            degradedFrom: "heavy",
          }),
        ],
      })
    );

    expect(view.running[0]).toMatchObject({
      degraded: { from: "heavy", to: "light" },
      paused: null,
      mode: "afk",
    });
  });

  it("shows no degrade on a run still running at the tier it was given", () => {
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1" })],
        runs: [makeRun({ id: "r1", projectId: "p1", model: "heavy" })],
      })
    );

    expect(view.running[0].degraded).toBeNull();
  });

  it("claims no degrade from a half-written row", () => {
    // `degraded_from` is only ever written beside the tier stepped to, so a row
    // carrying one without the other could not say what it stepped between —
    // and half a claim on this screen is worse than none.
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1" })],
        runs: [makeRun({ id: "r1", projectId: "p1", model: null, degradedFrom: "heavy" })],
      })
    );

    expect(view.running[0].degraded).toBeNull();
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
        sessionSkill: null,
        phases: null,
        attempt: null,
        turns: 3,
        startedAt: TODAY_9AM.toISOString(),
        spend: { usd: 1.23, budgetUsd: null },
        paused: null,
        degraded: null,
      },
    ]);
  });

  it("labels a generation session with its skill and issue anchor (issue #61)", () => {
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1", name: "interlude" })],
        tasks: [
          makeTask({
            id: "t1",
            projectId: "p1",
            title: "Grill the fleet dashboard",
            sessionSkill: "grill-me",
            // The anchor lives in sessionIssue, never githubIssue, on a session.
            sessionIssue: "lennons301/interlude#61",
            containerStatus: "idle",
            turns: 2,
            createdAt: TODAY_9AM,
          }),
        ],
      })
    );

    expect(view.running).toHaveLength(1);
    const card = view.running[0];
    // Still an interactive session — a skill doesn't change the mode — but the
    // dashboard reads the skill to label it distinctly from a plain chat task.
    expect(card.mode).toBe("interactive");
    expect(card.sessionSkill).toBe("grill-me");
    expect(card.ticket).toBe("#61");
  });

  it("does not treat an autonomous triage pass as a generation session (issue #61)", () => {
    const view = buildFleetView(
      baseRows({
        projects: [makeProject({ id: "p1", name: "interlude" })],
        tasks: [
          makeTask({
            id: "t-triage",
            projectId: "p1",
            kind: "triage",
            title: "Triage: something",
            containerStatus: "running",
            createdAt: TODAY_9AM,
          }),
        ],
      })
    );

    expect(view.running).toHaveLength(1);
    expect(view.running[0].mode).toBe("triage");
    expect(view.running[0].sessionSkill).toBeNull();
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
        sessionSkill: null,
        phases: null,
        attempt: null,
        turns: 1,
        startedAt: TODAY_9AM.toISOString(),
        spend: { usd: 0.8, budgetUsd: 2 },
        paused: null,
        degraded: null,
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

  it("keeps a dangling run visible but drops it once finalized (issue #106)", () => {
    // The #106 ghost: an implement pass ended with no PR and no BLOCKED
    // question, so its task completed but nothing drove the run out of
    // `implementing` — the slot is free (the task holds no container) yet the
    // run still reads as active fleet work. This asserts the read model's half
    // of the contract: a non-terminal run renders a running card, and the same
    // run finalized (the fix drives it to `failed`) renders none.
    const danglingRows = (status: FleetRunRow["status"]) =>
      baseRows({
        projects: [makeProject({ id: "p1" })],
        runs: [makeRun({ id: "r1", projectId: "p1", status })],
        tasks: [
          makeTask({
            id: "t1",
            projectId: "p1",
            runId: "r1",
            kind: "implement",
            status: "completed",
            containerStatus: null,
          }),
        ],
      });

    // Before the fix: the dangling `implementing` run is the ghost running card.
    const ghost = buildFleetView(danglingRows("implementing"));
    expect(ghost.running.map((c) => c.runId)).toEqual(["r1"]);
    expect(ghost.slots.used).toBe(0);

    // After the fix drives the run terminal: no running card, no ghost.
    const finalized = buildFleetView(danglingRows("failed"));
    expect(finalized.running).toEqual([]);
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
      { projectName: "interlude", count: 2, hold: "autonomy-off" },
      { projectName: "lemons", count: 0, hold: "preflight-unchecked" },
    ]);
    expect(view.autonomyOn).toBe(true);
  });

  it("marks each project's backlog with what would refuse it, and nothing when it is pickable", () => {
    const view = buildFleetView(
      baseRows({
        backlogByProject: { p1: 3, p2: 2, p3: 1, p4: 4 },
        projects: [
          makeProject({ id: "p1", name: "armed", autonomyEnabled: true, preflightStatus: "passing" }),
          makeProject({
            id: "p2",
            name: "broken",
            autonomyEnabled: true,
            preflightStatus: "failing",
            preflightReason: "no branch protection",
          }),
          makeProject({ id: "p3", name: "unchecked", autonomyEnabled: true, preflightStatus: null }),
          makeProject({ id: "p4", name: "dormant", autonomyEnabled: false, preflightStatus: "passing" }),
        ],
      })
    );

    expect(view.queue.byProject).toEqual([
      { projectName: "dormant", count: 4, hold: "autonomy-off" },
      { projectName: "armed", count: 3, hold: null },
      { projectName: "broken", count: 2, hold: "preflight-failing" },
      { projectName: "unchecked", count: 1, hold: "preflight-unchecked" },
    ]);
  });

  it("keeps per-project holds out of the fleet-wide field, and the fleet-wide hold out of the rows", () => {
    // The boot master holds everything, but it is said once — a row's `hold`
    // stays the project's own answer, so the two can't double-count.
    const view = buildFleetView(
      baseRows({
        autonomyEnabledAtBoot: false,
        backlogByProject: { p1: 3 },
        projects: [
          makeProject({ id: "p1", name: "armed", autonomyEnabled: true, preflightStatus: "passing" }),
        ],
      })
    );

    expect(view.pickupPaused?.reason).toBe("autonomy-off-at-boot");
    expect(view.queue.byProject).toEqual([
      { projectName: "armed", count: 3, hold: null },
    ]);
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

describe("quota (issue #167)", () => {
  const OBSERVED_AT = new Date(2026, 7, 1, 11, 45, 0);
  const RESETS_AT = new Date(2026, 7, 1, 14, 0, 0);

  function observation(
    overrides: Partial<NonNullable<FleetRows["quota"]>> = {}
  ): NonNullable<FleetRows["quota"]> {
    return {
      status: "allowed_warning",
      rateLimitType: "seven_day_opus",
      utilization: 91,
      resetsAt: RESETS_AT,
      overageStatus: null,
      overageResetsAt: null,
      isUsingOverage: false,
      overageInUse: null,
      observedAt: OBSERVED_AT,
      ...overrides,
    };
  }

  it("says nothing rather than guessing when nothing has been observed", () => {
    expect(buildFleetView(baseRows()).quota).toBeNull();
  });

  it("renders the observation in the tile's terms", () => {
    const view = buildFleetView(baseRows({ quota: observation() }));

    expect(view.quota).toEqual({
      status: "allowed_warning",
      severity: "warning",
      limitLabel: "weekly opus",
      utilization: 91,
      resetsAt: RESETS_AT.toISOString(),
      observedAt: OBSERVED_AT.toISOString(),
    });
  });

  it("carries an unreported utilization and reset through as null", () => {
    // The usual shape on the owner's account: absent, not zero, and the tile
    // has to be able to tell the difference.
    const view = buildFleetView(
      baseRows({
        quota: observation({ status: "allowed", utilization: null, resetsAt: null }),
      })
    );

    expect(view.quota).toMatchObject({
      severity: "ok",
      utilization: null,
      resetsAt: null,
    });
  });

  it("shows a limit type this build has never heard of, as itself", () => {
    const view = buildFleetView(
      baseRows({
        quota: observation({ status: "throttled_soft", rateLimitType: "thirty_day" }),
      })
    );

    expect(view.quota).toMatchObject({
      status: "throttled_soft",
      severity: "unknown",
      limitLabel: "thirty_day",
    });
  });
});

/**
 * Whose quota it is (issue #175). The observation is per-lane in the database;
 * the view's job is to carry the lane beside it so a null reading can be told
 * apart from a lane that will never produce one.
 */
describe("the quota's lane (issue #175)", () => {
  it("says nothing about a lane when none resolves", () => {
    // An unusable lanes.yaml. The tile may not claim the fleet is metered.
    expect(buildFleetView(baseRows()).quotaLane).toBeNull();
  });

  it("marks a subscription lane as one that can report a window", () => {
    const view = buildFleetView(
      baseRows({
        quotaLane: {
          id: "claude-subscription",
          label: "Claude subscription",
          billing: "subscription",
        },
      })
    );

    expect(view.quotaLane).toEqual({
      id: "claude-subscription",
      label: "Claude subscription",
      billing: "subscription",
      reportsQuota: true,
    });
  });

  it("marks every metered lane as one that never will", () => {
    // The unified-window machinery is subscription-only (#165's finding 6),
    // confirmed against OpenRouter on 2026-09-02 — no rate-limit headers and no
    // `rate_limit_event` on a full harness turn. Anthropic's own API lane is
    // metered too, and is equally silent.
    for (const id of ["openrouter-glm", "anthropic-api"]) {
      const view = buildFleetView(
        baseRows({ quotaLane: { id, label: id, billing: "metered" } })
      );
      expect(view.quotaLane?.reportsQuota).toBe(false);
    }
  });

  it("leaves a lane's reading untouched — nothing here merges two lanes", () => {
    // The failure this ticket exists to make impossible: a reading is the lane
    // it was handed with, never an inherited one. The rows arrive already
    // keyed by lane from the store, so the view must not reconcile them.
    const view = buildFleetView(
      baseRows({
        quota: null,
        quotaLane: {
          id: "openrouter-glm",
          label: "OpenRouter (GLM open weights)",
          billing: "metered",
        },
      })
    );

    expect(view.quota).toBeNull();
    expect(view.quotaLane?.id).toBe("openrouter-glm");
  });

  it("raises an undelivered-answer card pointing at the session (#136)", () => {
    const view = buildFleetView(
      baseRows({
        fleetHealth: {
          owedReviewStalls: [],
          pickupWedged: null,
          queueStale: null,
          undeliveredAnswers: [
            {
              taskId: "t-62",
              label: "moontide #62",
              issueRef: "lennons301/moontide#62",
              taskUrl: "/tasks/t-62",
              queuedAtMs: 0,
              undeliveredForMs: 95 * 60_000,
            },
          ],
        },
      })
    );

    expect(view.needsYou).toEqual([
      {
        cause: "answer-undelivered",
        severity: "red",
        context: "moontide #62",
        body:
          "Your answer has sat undelivered for 1h 35m — the agent never received it. " +
          "The parked session is not resuming; restart the app to re-adopt it.",
        action: { label: "Open session", href: "/tasks/t-62" },
      },
    ]);
  });
});
