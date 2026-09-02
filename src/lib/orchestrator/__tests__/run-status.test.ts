import { describe, it, expect, beforeEach } from "vitest";
import { inArray } from "drizzle-orm";
import { createTestDb } from "@/test/create-test-db";
import * as schema from "@/db/schema";
import {
  ACTIVE_RUN_STATUSES,
  RECLAIMABLE_RUN_STATUSES,
} from "../run-status";

/**
 * The two questions the run-status vocabulary answers, asked the way their
 * callers ask them — as a query over a seeded ledger rather than as a set
 * comparison, so the assertion is about which rows come back rather than about
 * which strings are in a list.
 *
 * Both matter most for the status added last: a `rate_limited` run (issue #168)
 * is waiting on a clock, and a restart is not that clock. Boot recovery
 * re-claiming it would spend the attempt the pause exists to protect; the sweep
 * claiming a second run over it would spend one too.
 */

let db: ReturnType<typeof createTestDb>["db"];

type RunStatus = (typeof schema.runs.$inferSelect)["status"];

function seedRun(id: string, status: RunStatus): void {
  db.insert(schema.runs)
    .values({
      id,
      projectId: "p1",
      githubIssue: `owner/repo#${id}`,
      attempt: 1,
      mode: "autonomous",
      status,
      budgetUsd: 20,
      claimedAt: new Date(),
      ...(status === "rate_limited"
        ? { resumeAfter: new Date("2026-09-01T17:00:00.000Z") }
        : {}),
    })
    .run();
}

beforeEach(() => {
  db = createTestDb().db;
  db.insert(schema.projects)
    .values({ id: "p1", name: "lemons", createdAt: new Date() })
    .run();
});

describe("boot recovery's reclaim set", () => {
  it("passes over a run parked on its quota clock", () => {
    // The ticket's boot-recovery promise: a paused run is left exactly as it
    // is — not re-claimed (which spends an attempt), not failed (which spends
    // three), not marked interrupted (which spends a bound that measures
    // restarts). It waits on `resumeAfter`, which outlives the process.
    seedRun("paused", "rate_limited");
    seedRun("working", "implementing");

    const reclaimed = db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(inArray(schema.runs.status, [...RECLAIMABLE_RUN_STATUSES]))
      .all();

    expect(reclaimed.map((r) => r.id)).toEqual(["working"]);
  });

  it("passes over the runs waiting on a human, as it always has", () => {
    seedRun("gated", "gated");
    seedRun("blocked", "blocked");

    expect(
      db
        .select({ id: schema.runs.id })
        .from(schema.runs)
        .where(inArray(schema.runs.status, [...RECLAIMABLE_RUN_STATUSES]))
        .all()
    ).toEqual([]);
  });
});

describe("the set that means 'this ticket is being worked'", () => {
  it("counts a paused run, so no second run is claimed over its ticket", () => {
    seedRun("paused", "rate_limited");

    const active = db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(inArray(schema.runs.status, [...ACTIVE_RUN_STATUSES]))
      .all();

    expect(active.map((r) => r.id)).toEqual(["paused"]);
  });

  it("does not count a run that actually finished", () => {
    seedRun("done", "merged");
    seedRun("dead", "failed");
    seedRun("burnt", "exhausted");

    expect(
      db
        .select({ id: schema.runs.id })
        .from(schema.runs)
        .where(inArray(schema.runs.status, [...ACTIVE_RUN_STATUSES]))
        .all()
    ).toEqual([]);
  });
});
