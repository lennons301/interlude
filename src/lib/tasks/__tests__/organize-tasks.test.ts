import { describe, it, expect } from "vitest";
import {
  organizeTasks,
  taskChip,
  taskTicket,
  TASK_CHIPS,
  type TaskListRow,
} from "../organize-tasks";

// Fixed clock: every row states its own updatedAt, so recency ordering is
// unambiguous without a real one.
const T = (minutesAgo: number) =>
  new Date(Date.UTC(2026, 7, 1, 12, 0, 0) - minutesAgo * 60_000).toISOString();

function makeRow(overrides: Partial<TaskListRow> = {}): TaskListRow {
  return {
    id: "task-1",
    projectId: "proj-1",
    projectName: "lemons",
    title: "A task",
    status: "completed",
    kind: "interactive",
    sessionSkill: null,
    runId: null,
    githubIssue: null,
    sessionIssue: null,
    costUsd: 0,
    updatedAt: T(0),
    ...overrides,
  };
}

describe("taskTicket", () => {
  it("names a run's ticket without the owner/repo prefix", () => {
    expect(
      taskTicket(makeRow({ githubIssue: "lennons301/lemons#34" }))
    ).toBe("#34");
  });

  it("falls back to a session's anchor", () => {
    expect(
      taskTicket(makeRow({ sessionIssue: "lennons301/interlude#61" }))
    ).toBe("#61");
  });

  it("is null for unanchored work", () => {
    expect(taskTicket(makeRow())).toBeNull();
  });

  it("passes through a ref it cannot parse rather than dropping it", () => {
    expect(taskTicket(makeRow({ githubIssue: "lemons-34" }))).toBe("lemons-34");
  });
});

describe("taskChip", () => {
  it("names an ordinary chat task", () => {
    expect(taskChip(makeRow())).toBe("chat");
  });

  it("names a generation session by its skill, not by its kind", () => {
    const cases: Array<[TaskListRow["sessionSkill"], string]> = [
      ["grill-me", "grill"],
      ["grill-with-docs", "grill"],
      ["to-spec", "spec"],
      ["to-tickets", "tickets"],
      ["wayfinder", "wayfinder"],
      ["triage", "triage"],
    ];
    for (const [sessionSkill, chip] of cases) {
      expect(taskChip(makeRow({ sessionSkill }))).toBe(chip);
    }
  });

  it("names each autonomous pass by its kind", () => {
    const cases: Array<[TaskListRow["kind"], string]> = [
      ["implement", "implement"],
      ["review", "review"],
      ["triage", "triage"],
      ["repair", "repair"],
    ];
    for (const [kind, chip] of cases) {
      expect(taskChip(makeRow({ kind, runId: "run-1" }))).toBe(chip);
    }
  });

  it("only ever produces chips from the published vocabulary", () => {
    const rows = [
      makeRow(),
      makeRow({ sessionSkill: "grill-me" }),
      makeRow({ kind: "implement", runId: "run-1" }),
      makeRow({ kind: "review", runId: "run-1" }),
      makeRow({ kind: "triage" }),
      makeRow({ kind: "repair", runId: "run-1" }),
    ];
    for (const row of rows) {
      expect(TASK_CHIPS).toContain(taskChip(row));
    }
  });
});

describe("organizeTasks — the split", () => {
  it("separates interactive sessions from autonomous runs", () => {
    const rows = [
      makeRow({ id: "chat", kind: "interactive" }),
      makeRow({ id: "grill", kind: "interactive", sessionSkill: "grill-me" }),
      makeRow({ id: "impl", kind: "implement", runId: "run-1" }),
      makeRow({ id: "review", kind: "review", runId: "run-1" }),
    ];

    const organized = organizeTasks(rows, "all");

    expect(organized.interactive.map((r) => r.id)).toEqual(["chat", "grill"]);
    expect(organized.autonomous.map((r) => r.id)).toEqual(["impl", "review"]);
    expect(organized.total).toBe(4);
  });

  it("counts an unattended triage pass as autonomous and a triage session as interactive", () => {
    const rows = [
      makeRow({ id: "pass", kind: "triage" }),
      makeRow({ id: "session", kind: "interactive", sessionSkill: "triage" }),
    ];

    const organized = organizeTasks(rows, "all");

    expect(organized.autonomous.map((r) => r.id)).toEqual(["pass"]);
    expect(organized.interactive.map((r) => r.id)).toEqual(["session"]);
  });

  it("treats an interactive task owned by a run as loop bookkeeping", () => {
    const rows = [makeRow({ id: "owned", kind: "interactive", runId: "run-1" })];

    const organized = organizeTasks(rows, "all");

    expect(organized.interactive).toEqual([]);
    expect(organized.autonomous.map((r) => r.id)).toEqual(["owned"]);
  });

  it("orders both sections by most recent activity", () => {
    const rows = [
      makeRow({ id: "old-chat", updatedAt: T(90) }),
      makeRow({ id: "new-chat", updatedAt: T(2) }),
      makeRow({ id: "old-run", kind: "implement", runId: "r", updatedAt: T(60) }),
      makeRow({ id: "new-run", kind: "implement", runId: "r", updatedAt: T(5) }),
    ];

    const organized = organizeTasks(rows, "all");

    expect(organized.interactive.map((r) => r.id)).toEqual([
      "new-chat",
      "old-chat",
    ]);
    expect(organized.autonomous.map((r) => r.id)).toEqual(["new-run", "old-run"]);
  });

  it("does not mutate the rows it was given", () => {
    const rows = [
      makeRow({ id: "old", updatedAt: T(90) }),
      makeRow({ id: "new", updatedAt: T(1) }),
    ];

    organizeTasks(rows, "all");

    expect(rows.map((r) => r.id)).toEqual(["old", "new"]);
  });

  it("returns both sections empty for an empty list", () => {
    const organized = organizeTasks([], "all");

    expect(organized).toEqual({
      interactive: [],
      autonomous: [],
      chips: [],
      total: 0,
    });
  });
});

describe("organizeTasks — the filter", () => {
  const rows = [
    makeRow({ id: "chat" }),
    makeRow({ id: "grill-a", sessionSkill: "grill-me" }),
    makeRow({ id: "grill-b", sessionSkill: "grill-with-docs" }),
    makeRow({ id: "impl", kind: "implement", runId: "run-1" }),
    makeRow({ id: "review", kind: "review", runId: "run-1" }),
  ];

  it("narrows both sections to one kind", () => {
    const organized = organizeTasks(rows, "grill");

    expect(organized.interactive.map((r) => r.id)).toEqual([
      "grill-a",
      "grill-b",
    ]);
    expect(organized.autonomous).toEqual([]);
  });

  it("folds both grilling skills into the one grill chip", () => {
    expect(organizeTasks(rows, "grill").interactive).toHaveLength(2);
  });

  it("keeps everything under 'all'", () => {
    const organized = organizeTasks(rows, "all");

    expect(organized.interactive).toHaveLength(3);
    expect(organized.autonomous).toHaveLength(2);
  });

  it("filters the autonomous section too", () => {
    const organized = organizeTasks(rows, "implement");

    expect(organized.interactive).toEqual([]);
    expect(organized.autonomous.map((r) => r.id)).toEqual(["impl"]);
  });

  it("yields an empty list for a kind nothing matches", () => {
    const organized = organizeTasks(rows, "triage");

    expect(organized.interactive).toEqual([]);
    expect(organized.autonomous).toEqual([]);
    // The filter narrows what is shown; it never changes what exists.
    expect(organized.total).toBe(5);
  });

  it("offers only the kinds present, in vocabulary order, with counts", () => {
    expect(organizeTasks(rows, "all").chips).toEqual([
      { chip: "chat", count: 1 },
      { chip: "grill", count: 2 },
      { chip: "implement", count: 1 },
      { chip: "review", count: 1 },
    ]);
  });

  it("counts over the whole list, not the filtered view, so the filter can be changed back", () => {
    expect(organizeTasks(rows, "implement").chips).toEqual(
      organizeTasks(rows, "all").chips
    );
  });
});
