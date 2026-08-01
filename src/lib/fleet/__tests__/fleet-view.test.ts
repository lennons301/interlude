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
