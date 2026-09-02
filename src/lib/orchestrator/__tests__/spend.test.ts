import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb } from "@/test/create-test-db";
import {
  bookTaskCost,
  localDayKey,
  recordMeteredSpend,
  todayAutonomousSpendUsd,
  todayMeteredSpendUsd,
  startOfLocalDay,
} from "../spend";

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

  it("counts today's triage passes — autonomous spend without a run", () => {
    testDb
      .insert(schema.tasks)
      .values({
        id: "triage-task",
        projectId: "test-project",
        title: "Triage: add export",
        kind: "triage",
        totalCostUsd: 1.75,
        createdAt: TODAY_9AM,
        updatedAt: TODAY_9AM,
      })
      .run();
    insertRun({ totalCostUsd: 1.5 });

    expect(todayAutonomousSpendUsd(NOW)).toBeCloseTo(3.25);
  });

  it("excludes triage passes created before local midnight", () => {
    testDb
      .insert(schema.tasks)
      .values({
        id: "triage-task-old",
        projectId: "test-project",
        title: "Triage: add export",
        kind: "triage",
        totalCostUsd: 2,
        createdAt: YESTERDAY_11PM,
        updatedAt: YESTERDAY_11PM,
      })
      .run();

    expect(todayAutonomousSpendUsd(NOW)).toBe(0);
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

/**
 * The real-money ledger (issue #174). What makes it a ledger rather than a sum
 * is the thing tested hardest here: an increment is booked to the day it
 * lands on, so a task whose running total spans days is attributed exactly
 * rather than guessed at from a column on its row.
 */
describe("the real-money ledger", () => {
  beforeEach(() => {
    testDb = createTestDb().db;
  });

  it("reads zero on a day nothing was charged", () => {
    expect(todayMeteredSpendUsd(NOW)).toBe(0);
  });

  it("keys days by the local calendar, not UTC", () => {
    expect(localDayKey(new Date(2026, 7, 1, 0, 0, 0))).toBe("2026-08-01");
    expect(localDayKey(new Date(2026, 7, 1, 23, 59, 59))).toBe("2026-08-01");
    expect(localDayKey(new Date(2026, 6, 31, 23, 0, 0))).toBe("2026-07-31");
  });

  it("books only the increment, so a running total is never re-counted", () => {
    recordMeteredSpend(0, 4, TODAY_9AM);
    recordMeteredSpend(4, 6.5, NOW);

    expect(todayMeteredSpendUsd(NOW)).toBeCloseTo(6.5);
  });

  it("is idempotent — the same total written twice adds nothing", () => {
    recordMeteredSpend(0, 4, NOW);
    recordMeteredSpend(4, 4, NOW);

    expect(todayMeteredSpendUsd(NOW)).toBeCloseTo(4);
  });

  it("treats a decrease as no spend, never as a refund", () => {
    recordMeteredSpend(0, 10, NOW);
    recordMeteredSpend(10, 3, NOW);

    expect(todayMeteredSpendUsd(NOW)).toBeCloseTo(10);
  });

  it("splits a task's spend across the days it actually spent on", () => {
    // The case no column on the task row could answer: a session opened
    // yesterday, driven again today. Yesterday keeps its $9; today owes $2.
    recordMeteredSpend(0, 9, YESTERDAY_11PM);
    recordMeteredSpend(9, 11, NOW);

    expect(todayMeteredSpendUsd(YESTERDAY_11PM)).toBeCloseTo(9);
    expect(todayMeteredSpendUsd(NOW)).toBeCloseTo(2);
  });

  it("keeps a past day readable, so the digest reports the day it covers", () => {
    recordMeteredSpend(0, 12, YESTERDAY_11PM);

    expect(todayMeteredSpendUsd(NOW)).toBe(0);
    expect(todayMeteredSpendUsd(YESTERDAY_11PM)).toBeCloseTo(12);
  });

  it("counts a spend at the very start of the day into that day", () => {
    recordMeteredSpend(0, 1, MIDNIGHT);

    expect(todayMeteredSpendUsd(NOW)).toBeCloseTo(1);
  });
});

/**
 * Booking a task's cost — the funnel every cost write goes through, and the
 * one place the "does this dollar count?" question is answered (issues #174,
 * #173).
 *
 * The overflow path (#173) is where an *interactive* task first touches real
 * money, and interactive work is exempt from the $500 autonomous cap by
 * construction — it owns no run. So these cases are the check that the
 * exemption does not carry over to the cash cap: what decides is the pass's
 * recorded billing kind, never its kind of work.
 */
describe("booking a task's cost against the day", () => {
  beforeEach(() => {
    testDb = createTestDb().db;
    testDb
      .insert(schema.projects)
      .values({ id: "test-project", name: "Test", createdAt: new Date() })
      .run();
  });

  function insertTask(
    overrides: Partial<typeof schema.tasks.$inferInsert> = {}
  ): string {
    const id = `task-${Math.random().toString(36).slice(2)}`;
    testDb
      .insert(schema.tasks)
      .values({
        id,
        projectId: "test-project",
        title: "A chat session",
        kind: "interactive",
        createdAt: TODAY_9AM,
        updatedAt: TODAY_9AM,
        ...overrides,
      })
      .run();
    return id;
  }

  it("counts an interactive session that overflowed onto a paid lane", () => {
    const chat = insertTask({ lane: "openrouter", laneBilling: "metered" });

    bookTaskCost(chat, 2.5, NOW);

    expect(todayMeteredSpendUsd(NOW)).toBeCloseTo(2.5);
    // ...and it is still exempt from the quota-funded cap, which is the split
    // the two figures exist to keep.
    expect(todayAutonomousSpendUsd(NOW)).toBe(0);
  });

  it("counts a session an active overage is paying for", () => {
    // The lane declares itself a subscription; the crossing recorded `metered`
    // because the card is what is really being charged (issue #173).
    const chat = insertTask({
      lane: "claude-subscription",
      laneBilling: "metered",
    });

    bookTaskCost(chat, 1.25, NOW);

    expect(todayMeteredSpendUsd(NOW)).toBeCloseTo(1.25);
  });

  it("counts nothing for subscription work, whatever it spent", () => {
    const chat = insertTask({
      lane: "claude-subscription",
      laneBilling: "subscription",
    });

    bookTaskCost(chat, 40, NOW);

    expect(todayMeteredSpendUsd(NOW)).toBe(0);
  });

  it("counts nothing for a pass that predates lanes", () => {
    const chat = insertTask();

    bookTaskCost(chat, 3, NOW);

    expect(todayMeteredSpendUsd(NOW)).toBe(0);
  });

  it("books each turn's increment, so a driven session is not re-counted", () => {
    const chat = insertTask({ lane: "openrouter", laneBilling: "metered" });

    bookTaskCost(chat, 1, NOW);
    // What the turn manager does: write the new running total on the row, then
    // book the next one against it.
    testDb
      .update(schema.tasks)
      .set({ totalCostUsd: 1 })
      .where(eq(schema.tasks.id, chat))
      .run();
    bookTaskCost(chat, 3, NOW);

    expect(todayMeteredSpendUsd(NOW)).toBeCloseTo(3);
  });
});
