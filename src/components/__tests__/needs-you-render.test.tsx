import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NeedsYou } from "../fleet/needs-you";
import { buildFleetView, type FleetRows } from "@/lib/fleet/fleet-view";

/**
 * The panel's decisions live in `buildFleetView` and are tested there. What
 * this covers is the one line the component composes itself: the quiet
 * sub-line under "Nothing needs you", which used to report the fleet as armed
 * while a fleet-wide hold stopped every claim (issue #148).
 */
function render(overrides: Partial<FleetRows> = {}): string {
  const view = buildFleetView({
    now: new Date(2026, 7, 1, 12, 0, 0),
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
    autonomyEnabledAtBoot: true,
    discordGuildId: null,
    projects: [
      {
        id: "p1",
        name: "lemons",
        autonomyEnabled: true,
        preflightStatus: "passing",
        preflightReason: null,
        discordChannelId: null,
      },
    ],
    runs: [],
    tasks: [],
    backlogByProject: { p1: 0 },
    needsHumanByProject: null,
    fleetHealth: null,
    failingChecksByRun: null,
    quota: null,
    quotaLane: null,
    quotaThresholdPercent: 90,
    ...overrides,
  });
  return renderToStaticMarkup(<NeedsYou view={view} />);
}

/** A run that spent the whole daily cap inside the covered day */
const CAP_SPENDING_RUN: FleetRows["runs"][number] = {
  id: "r1",
  projectId: "p1",
  githubIssue: "lennons301/lemons#34",
  attempt: 1,
  mode: "autonomous",
  status: "merged",
  budgetUsd: 20,
  totalCostUsd: 500,
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
  declaredTier: null,
  harness: null,
  claimedAt: new Date(2026, 7, 1, 9, 0, 0),
  startedAt: new Date(2026, 7, 1, 9, 0, 0),
  finishedAt: new Date(2026, 7, 1, 10, 0, 0),
};

describe("NeedsYou — the quiet sub-line", () => {
  it("reports the fleet as armed when nothing holds pickup", () => {
    expect(render()).toContain("No active runs · queue empty · autonomy on");
  });

  it("names the hold instead when the boot master is off", () => {
    const html = render({ autonomyEnabledAtBoot: false });

    expect(html).toContain("pickup off");
    // Never both — "autonomy on" beside a fleet that can claim nothing is the bug
    expect(html).not.toContain("autonomy on");
  });

  it("uses each hold's own word, so the sub-line and the dot cannot disagree", () => {
    expect(render({ globalAutonomyPaused: true })).toContain("pickup held");
    expect(render({ runs: [CAP_SPENDING_RUN] })).toContain("pickup paused");
  });
});
