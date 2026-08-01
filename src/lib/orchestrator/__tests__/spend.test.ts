import { describe, it, expect, beforeEach, vi } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb } from "@/test/create-test-db";
import { todayAutonomousSpendUsd, startOfLocalDay } from "../spend";

// Use an in-memory SQLite database for tests
let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

// Fixed clock: noon local time, so "today" is unambiguous
const NOW = new Date(2026, 7, 1, 12, 0, 0);
const TODAY_9AM = new Date(2026, 7, 1, 9, 0, 0);
const MIDNIGHT = new Date(2026, 7, 1, 0, 0, 0);
const YESTERDAY_11PM = new Date(2026, 6, 31, 23, 0, 0);

let runSeq = 0;

function insertRun(overrides: Partial<typeof schema.runs.$inferInsert> = {}) {
  testDb
    .insert(schema.runs)
    .values({
      id: `run-${++runSeq}`,
      projectId: "test-project",
      githubIssue: "owner/repo#1",
      attempt: 1,
      mode: "autonomous",
      budgetUsd: 20,
      claimedAt: TODAY_9AM,
      ...overrides,
    })
    .run();
}

describe("todayAutonomousSpendUsd", () => {
  beforeEach(() => {
    testDb = createTestDb().db;
    testDb
      .insert(schema.projects)
      .values({ id: "test-project", name: "Test", createdAt: new Date() })
      .run();
  });

  it("returns 0 when there are no runs", () => {
    expect(todayAutonomousSpendUsd(NOW)).toBe(0);
  });

  it("sums cost across today's runs, autonomous and supervised alike", () => {
    insertRun({ totalCostUsd: 12.5 });
    insertRun({ mode: "supervised", totalCostUsd: 7.25 });

    expect(todayAutonomousSpendUsd(NOW)).toBeCloseTo(19.75);
  });

  it("excludes runs claimed before local midnight", () => {
    insertRun({ claimedAt: YESTERDAY_11PM, totalCostUsd: 50 });
    insertRun({ claimedAt: TODAY_9AM, totalCostUsd: 3 });

    expect(todayAutonomousSpendUsd(NOW)).toBeCloseTo(3);
  });

  it("includes a run claimed exactly at local midnight", () => {
    insertRun({ claimedAt: MIDNIGHT, totalCostUsd: 5 });

    expect(todayAutonomousSpendUsd(NOW)).toBeCloseTo(5);
  });

  it("is unaffected by interactive task spend — exempt by construction", () => {
    testDb
      .insert(schema.tasks)
      .values({
        id: "interactive-task",
        projectId: "test-project",
        title: "Chat task",
        totalCostUsd: 42.42,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    insertRun({ totalCostUsd: 1.5 });

    expect(todayAutonomousSpendUsd(NOW)).toBeCloseTo(1.5);
  });
});

describe("startOfLocalDay", () => {
  it("returns local midnight of the given day", () => {
    const start = startOfLocalDay(NOW);
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(7);
    expect(start.getDate()).toBe(1);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getSeconds()).toBe(0);
    expect(start.getMilliseconds()).toBe(0);
  });

  it("does not mutate its input", () => {
    const input = new Date(NOW);
    startOfLocalDay(input);
    expect(input.getTime()).toBe(NOW.getTime());
  });
});
