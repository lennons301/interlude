import { describe, it, expect, beforeEach, vi } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb } from "@/test/create-test-db";

/**
 * The archive's kind filter (issue #142). The point of narrowing in SQL is what
 * the last test here asserts: the list is bounded to the most recent rows, so a
 * filter applied *after* that bound can only ever narrow the window. Production
 * already held 222 tasks and the loop mints implement/review rows far faster
 * than a human opens sessions, so "find a past grilling session" was already
 * partly unreachable — the session had fallen out of the window before the
 * filter ever saw it.
 */
let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

import { GET as getTasks } from "@/app/api/tasks/route";
import {
  taskChip,
  TASK_CHIPS,
  type TaskListRow,
} from "@/lib/tasks/organize-tasks";

const T = (minutesAgo: number) =>
  new Date(Date.UTC(2026, 7, 1, 12, 0, 0) - minutesAgo * 60_000);

let seq = 0;

function insertTask(
  overrides: Partial<typeof schema.tasks.$inferInsert> = {}
): string {
  const id = `task-${++seq}`;
  testDb
    .insert(schema.tasks)
    .values({
      id,
      projectId: "p1",
      title: id,
      description: "",
      status: "completed",
      createdAt: T(60),
      updatedAt: T(60),
      ...overrides,
    })
    .run();
  return id;
}

async function list(query = ""): Promise<TaskListRow[]> {
  const res = await getTasks(new Request(`http://test/api/tasks${query}`));
  expect(res.status).toBe(200);
  return res.json();
}

describe("GET /api/tasks?kind=", () => {
  beforeEach(() => {
    seq = 0;
    testDb = createTestDb().db;
    testDb
      .insert(schema.projects)
      .values({ id: "p1", name: "lemons", createdAt: T(1000) })
      .run();
    testDb
      .insert(schema.runs)
      .values({
        id: "run-1",
        projectId: "p1",
        githubIssue: "lennons301/lemons#34",
        attempt: 1,
        mode: "autonomous",
        budgetUsd: 20,
        claimedAt: T(90),
      })
      .run();
  });

  it("narrows to one chip, reading both columns the chip is made of", async () => {
    const chat = insertTask();
    insertTask({ sessionSkill: "grill-me" });
    insertTask({ kind: "implement", runId: "run-1" });

    expect((await list("?kind=chat")).map((r) => r.title)).toEqual([chat]);
  });

  it("folds both grilling skills into the one grill chip", async () => {
    const a = insertTask({ sessionSkill: "grill-me", updatedAt: T(2) });
    const b = insertTask({ sessionSkill: "grill-with-docs", updatedAt: T(3) });
    insertTask({ sessionSkill: "to-spec" });

    expect((await list("?kind=grill")).map((r) => r.title)).toEqual([a, b]);
  });

  it("keeps a triage pass and a triage session together, as the chip does", async () => {
    const pass = insertTask({ kind: "triage", updatedAt: T(2) });
    const session = insertTask({ sessionSkill: "triage", updatedAt: T(3) });
    insertTask({ kind: "implement", runId: "run-1" });

    expect((await list("?kind=triage")).map((r) => r.title)).toEqual([
      pass,
      session,
    ]);
  });

  it("treats `all` and an empty parameter as the whole archive", async () => {
    insertTask();
    insertTask({ kind: "review", runId: "run-1" });

    expect(await list("?kind=all")).toHaveLength(2);
    expect(await list("?kind=")).toHaveLength(2);
  });

  it("rejects a kind outside the vocabulary instead of silently listing everything", async () => {
    insertTask();

    const res = await getTasks(
      new Request("http://test/api/tasks?kind=interactive")
    );

    // `interactive` is a column value, not a chip — refusing it is what stops a
    // caller thinking it filtered when it hadn't.
    expect(res.status).toBe(400);
  });

  it("applies the kind alongside status and projectId rather than replacing them", async () => {
    testDb
      .insert(schema.projects)
      .values({ id: "p2", name: "moontide", createdAt: T(1000) })
      .run();
    const wanted = insertTask({ sessionSkill: "grill-me", status: "queued" });
    insertTask({ sessionSkill: "grill-me", status: "completed" });
    insertTask({ sessionSkill: "grill-me", status: "queued", projectId: "p2" });
    insertTask({ status: "queued" });

    const rows = await list("?kind=grill&status=queued&projectId=p1");

    expect(rows.map((r) => r.title)).toEqual([wanted]);
  });

  it("reaches a row the bound had already cut off — the whole point", async () => {
    const old = insertTask({ sessionSkill: "grill-me", updatedAt: T(500) });
    for (let i = 0; i < 5; i++) {
      insertTask({ kind: "implement", runId: "run-1", updatedAt: T(i) });
    }

    // A window of 3 holds nothing but autonomous rows, so no client-side filter
    // over it could ever find the session.
    expect((await list("?limit=3")).map((r) => r.title)).not.toContain(old);
    expect((await list("?kind=grill&limit=3")).map((r) => r.title)).toEqual([
      old,
    ]);
  });

  it("returns exactly the rows the chip vocabulary claims, for every chip", async () => {
    // Every (kind, skill) pair the schema allows, so the SQL and `taskChip` are
    // compared over the whole space rather than a sample of it.
    const skills: (schema.SessionSkill | null)[] = [null, ...schema.SESSION_SKILLS];
    for (const kind of schema.tasks.kind.enumValues) {
      for (const sessionSkill of skills) {
        insertTask({
          kind,
          sessionSkill,
          // A run is what makes a row autonomous; kind is what makes it a chip.
          runId: kind === "interactive" ? null : "run-1",
        });
      }
    }
    const everything = await list();

    for (const chip of TASK_CHIPS) {
      const listed = (await list(`?kind=${chip}`)).map((r) => r.title);

      expect(listed.sort()).toEqual(
        everything
          .filter((row) => taskChip(row) === chip)
          .map((row) => row.title)
          .sort()
      );
    }
  });
});
