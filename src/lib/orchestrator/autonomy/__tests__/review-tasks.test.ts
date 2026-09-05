import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb } from "@/test/create-test-db";
import {
  cancelOrphanedRunTasks,
  inFlightReviewTaskId,
  queuedTasksReservingSlots,
  reapDeadReviewTasks,
  runningReviewTaskId,
  type Db,
} from "../review-tasks";
import { decideNext, passOutcomeSnapshot, type AutonomySnapshot } from "../decide";

const ISSUE_REF = "owner/repo#141";

/** A run parked in `reviewing` (auto-merge armed) awaiting its review pass. */
function seedReviewingRun(db: Db): void {
  db.insert(schema.projects).values({ id: "p1", name: "Test", createdAt: new Date() }).run();
  db.insert(schema.runs)
    .values({
      id: "run-1",
      projectId: "p1",
      githubIssue: ISSUE_REF,
      attempt: 1,
      mode: "autonomous",
      status: "reviewing",
      budgetUsd: 20,
      pullRequestNumber: 144,
      claimedAt: new Date(),
    })
    .run();
  // The parked implement pass keeps its (stopped) container while its PR is
  // reviewed — it stays `running`, and is never a review task.
  db.insert(schema.tasks)
    .values({
      id: "task-implement",
      projectId: "p1",
      title: "Implement pass",
      kind: "implement",
      runId: "run-1",
      status: "running",
      containerName: "interlude-task-implement",
      githubIssue: ISSUE_REF,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
}

/** A review task for run-1 in the given state. */
function seedReviewTask(
  db: Db,
  opts: { id?: string; status?: "queued" | "running"; containerName?: string | null } = {}
): string {
  const id = opts.id ?? "task-review";
  db.insert(schema.tasks)
    .values({
      id,
      projectId: "p1",
      title: "Review PR #144",
      kind: "review",
      runId: "run-1",
      status: opts.status ?? "running",
      containerName: opts.containerName === undefined ? "interlude-task-review" : opts.containerName,
      branch: "agent/issue-141",
      githubIssue: ISSUE_REF,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  return id;
}

/** A minimal, otherwise-inert snapshot with just this run awaiting review, so
 * the only decision on the table is whether to queue its review pass. */
function awaitingReviewSnapshot(hasReviewTask: boolean): AutonomySnapshot {
  const base = passOutcomeSnapshot(new Date(2026, 7, 5), {
    runId: "run-1",
    taskId: "task-implement",
    issueRef: ISSUE_REF,
    finalMessage: null,
    // The implement pass is awaiting review, so it produced a PR (moot here —
    // completedPasses is cleared below — but keeps the outcome well-formed).
    producedPr: true,
    outcome: { kind: "completed" },
    tier: null,
    laneId: null,
    laneFailover: null,
    resumesMade: 0,
  });
  return {
    ...base,
    completedPasses: [],
    awaitingReview: [
      { runId: "run-1", issueRef: ISSUE_REF, prNumber: 144, armed: true, hasReviewTask },
    ],
  };
}

const alwaysGone = async () => false;
const alwaysLive = async () => true;

describe("review-pass in-flight + ungraceful-death reaping (issue #95)", () => {
  let db: Db;
  beforeEach(() => {
    db = createTestDb().db;
    seedReviewingRun(db);
  });

  it("reaps a review pass that died without a status transition, then queues exactly one replacement", async () => {
    const taskId = seedReviewTask(db, { status: "running" });

    // Before the reaper the stuck-`running` task reads as in flight — so a
    // naive re-queue would either stall (never replacing it) or race a
    // duplicate against it.
    expect(inFlightReviewTaskId(db, "run-1")).toBe(taskId);

    // Container confirmed gone: the reaper marks the task terminal.
    const reaped = await reapDeadReviewTasks(db, alwaysGone);
    expect(reaped).toEqual([{ taskId, containerName: "interlude-task-review" }]);
    expect(db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get()!.status).toBe(
      "failed"
    );

    // With the dead pass terminalized, no review is in flight — the reducer
    // queues one deliberate replacement, not zero and not two.
    expect(inFlightReviewTaskId(db, "run-1")).toBeNull();
    const startReviews = decideNext(awaitingReviewSnapshot(false)).filter(
      (a) => a.type === "startReview"
    );
    expect(startReviews).toEqual([
      { type: "startReview", runId: "run-1", issueRef: ISSUE_REF, prNumber: 144, armed: true },
    ]);
  });

  it("leaves a live review pass alone — it stays in flight and no second is queued", async () => {
    const taskId = seedReviewTask(db, { status: "running" });

    const reaped = await reapDeadReviewTasks(db, alwaysLive);
    expect(reaped).toEqual([]);
    expect(db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get()!.status).toBe(
      "running"
    );

    expect(inFlightReviewTaskId(db, "run-1")).toBe(taskId);
    const startReviews = decideNext(awaitingReviewSnapshot(true)).filter(
      (a) => a.type === "startReview"
    );
    expect(startReviews).toEqual([]);
  });

  it("counts a queued (not yet started) review as in flight", async () => {
    const taskId = seedReviewTask(db, { status: "queued", containerName: null });
    // A queued task has no container — the reaper never touches it...
    expect(await reapDeadReviewTasks(db, alwaysGone)).toEqual([]);
    // ...and it still blocks a second queueing.
    expect(inFlightReviewTaskId(db, "run-1")).toBe(taskId);
  });

  it("does not reap a review pass still provisioning its container (running, no name yet)", async () => {
    const taskId = seedReviewTask(db, { status: "running", containerName: null });
    expect(await reapDeadReviewTasks(db, alwaysGone)).toEqual([]);
    expect(db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get()!.status).toBe(
      "running"
    );
  });

  it("reaps only once — a queued replacement is not itself reaped or double-queued", async () => {
    seedReviewTask(db, { id: "task-review-1", status: "running" });
    await reapDeadReviewTasks(db, alwaysGone);

    // The sweep queued a replacement (kept `queued` here — no slot yet).
    seedReviewTask(db, { id: "task-review-2", status: "queued", containerName: null });

    // A second sweep: the replacement has no container, so nothing is reaped,
    // and it counts as in flight so no third review is queued.
    expect(await reapDeadReviewTasks(db, alwaysGone)).toEqual([]);
    expect(inFlightReviewTaskId(db, "run-1")).toBe("task-review-2");
    const startReviews = decideNext(awaitingReviewSnapshot(true)).filter(
      (a) => a.type === "startReview"
    );
    expect(startReviews).toEqual([]);
  });
});

describe("runningReviewTaskId — only a running review counts as started (issue #126)", () => {
  let db: Db;
  beforeEach(() => {
    db = createTestDb().db;
    seedReviewingRun(db);
  });

  it("returns null when the review is only queued (owed, not started)", () => {
    const taskId = seedReviewTask(db, { status: "queued", containerName: null });
    // A queued review still blocks a duplicate...
    expect(inFlightReviewTaskId(db, "run-1")).toBe(taskId);
    // ...but has not started, so the owed-review watchdog sees no running pass.
    expect(runningReviewTaskId(db, "run-1")).toBeNull();
  });

  it("returns the task id once the review is running", () => {
    const taskId = seedReviewTask(db, { status: "running" });
    expect(runningReviewTaskId(db, "run-1")).toBe(taskId);
  });

  it("returns null when the run has no review task at all", () => {
    expect(runningReviewTaskId(db, "run-1")).toBeNull();
  });
});

describe("cancelOrphanedRunTasks — no task outlives its run (issue #124)", () => {
  let db: Db;
  beforeEach(() => {
    db = createTestDb().db;
    db.insert(schema.projects).values({ id: "p1", name: "Test", createdAt: new Date() }).run();
  });

  function seedRun(id: string, status: (typeof schema.runs.$inferInsert)["status"]): void {
    db.insert(schema.runs)
      .values({
        id,
        projectId: "p1",
        githubIssue: ISSUE_REF,
        attempt: 1,
        mode: "autonomous",
        status,
        budgetUsd: 20,
        pullRequestNumber: 144,
        claimedAt: new Date(),
      })
      .run();
  }

  function seedTask(opts: {
    id: string;
    runId: string;
    kind: (typeof schema.tasks.$inferInsert)["kind"];
    status: (typeof schema.tasks.$inferInsert)["status"];
    containerName?: string | null;
  }): void {
    db.insert(schema.tasks)
      .values({
        id: opts.id,
        projectId: "p1",
        title: opts.id,
        kind: opts.kind,
        runId: opts.runId,
        status: opts.status,
        containerName: opts.containerName ?? null,
        containerStatus: opts.status === "running" ? "idle" : null,
        githubIssue: ISSUE_REF,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
  }

  const statusOf = (id: string) =>
    db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!.status;

  it("cancels a review task left queued when its run finalized to merged", () => {
    seedRun("run-1", "merged");
    // The parked implement pass was released to `completed` by its own path
    // before this runs; only the never-started review is the orphan.
    seedTask({ id: "task-impl", runId: "run-1", kind: "implement", status: "completed" });
    seedTask({ id: "task-review", runId: "run-1", kind: "review", status: "queued" });

    const cancelled = cancelOrphanedRunTasks(db, "run-1");

    expect(cancelled).toEqual([{ taskId: "task-review", containerName: null }]);
    expect(statusOf("task-review")).toBe("cancelled");
    // A terminal task is left exactly as it was.
    expect(statusOf("task-impl")).toBe("completed");
  });

  it("returns a still-running pass's container so the caller can remove it, and clears container_status", () => {
    // A human merged the PR while the review pass was actually running.
    seedRun("run-1", "merged");
    seedTask({
      id: "task-review",
      runId: "run-1",
      kind: "review",
      status: "running",
      containerName: "interlude-task-review",
    });

    const cancelled = cancelOrphanedRunTasks(db, "run-1");

    expect(cancelled).toEqual([{ taskId: "task-review", containerName: "interlude-task-review" }]);
    const row = db.select().from(schema.tasks).where(eq(schema.tasks.id, "task-review")).get()!;
    expect(row.status).toBe("cancelled");
    // Cleared alongside the terminal status so the row can never later read as
    // a live session (cf. issue #46).
    expect(row.containerStatus).toBeNull();
  });

  it("touches only the finalized run's tasks — a live run's owed review is untouched (self-heal preserved, AC #4)", () => {
    seedRun("dead", "failed");
    seedRun("live", "reviewing");
    seedTask({ id: "dead-review", runId: "dead", kind: "review", status: "queued" });
    seedTask({ id: "live-review", runId: "live", kind: "review", status: "queued" });

    cancelOrphanedRunTasks(db, "dead");

    expect(statusOf("dead-review")).toBe("cancelled");
    expect(statusOf("live-review")).toBe("queued");
    // The existing self-heal still sees the live run's owed review in flight.
    expect(inFlightReviewTaskId(db, "live")).toBe("live-review");
  });

  it("cancels a blocked pass too — the invariant covers every non-terminal status", () => {
    // A blocked pass holds a parked (stopped-but-preserved) container; if its
    // run is finalized, the pass must not be left waiting on an answer forever.
    seedRun("run-1", "cancelled");
    seedTask({
      id: "task-impl",
      runId: "run-1",
      kind: "implement",
      status: "blocked",
      containerName: "interlude-task-impl",
    });

    const cancelled = cancelOrphanedRunTasks(db, "run-1");

    expect(cancelled).toEqual([{ taskId: "task-impl", containerName: "interlude-task-impl" }]);
    expect(statusOf("task-impl")).toBe("cancelled");
  });

  it("is a no-op when the run owns no non-terminal task", () => {
    seedRun("run-1", "exhausted");
    seedTask({ id: "task-impl", runId: "run-1", kind: "implement", status: "failed" });

    expect(cancelOrphanedRunTasks(db, "run-1")).toEqual([]);
    expect(statusOf("task-impl")).toBe("failed");
  });

  it("regression: a hand-merged gated PR neither strands its review nor lets it reserve a slot (issue #124)", () => {
    // The LPS #135 shape at the DB seam the sweep drives: a gated run's PR was
    // merged by hand while its review pass sat queued (the single slot busy),
    // and a separate live run holds the slot with its own owed review.
    seedRun("merged", "merged");
    seedRun("live", "reviewing");
    seedTask({ id: "orphan-review", runId: "merged", kind: "review", status: "queued" });
    seedTask({ id: "live-review", runId: "live", kind: "review", status: "queued" });

    // executeFinalizeRun's cleanup terminalizes the orphan and leaves the live
    // run's owed review in flight (self-heal preserved).
    cancelOrphanedRunTasks(db, "merged");
    expect(statusOf("orphan-review")).toBe("cancelled");
    expect(statusOf("live-review")).toBe("queued");

    // gatherSnapshot's reservation accounting then counts only the live run's
    // review, so the dead-run orphan can never force claimableSlots to 0 — the
    // ~1.5h wedge this fixes.
    const stillQueued = db
      .select({ kind: schema.tasks.kind, runId: schema.tasks.runId })
      .from(schema.tasks)
      .where(eq(schema.tasks.status, "queued"))
      .all();
    expect(queuedTasksReservingSlots(stillQueued, new Set(["live"]))).toEqual([
      { kind: "review", runId: "live" },
    ]);
  });
});

describe("queuedTasksReservingSlots — dead-run tasks never reserve a slot (issue #124)", () => {
  it("keeps live-run and run-less tasks, drops tasks under a terminal run", () => {
    const liveRunIds = new Set(["r-live"]);
    const queued = [
      { kind: "review", runId: "r-dead" }, // orphan under a finalized run
      { kind: "review", runId: "r-live" }, // a genuinely owed review
      { kind: "implement", runId: "r-live" },
      { kind: "interactive", runId: null }, // no run — always real intent
      { kind: "triage", runId: null },
    ];

    expect(queuedTasksReservingSlots(queued, liveRunIds)).toEqual([
      { kind: "review", runId: "r-live" },
      { kind: "implement", runId: "r-live" },
      { kind: "interactive", runId: null },
      { kind: "triage", runId: null },
    ]);
  });

  it("drops every task when no run is live (the wedge: one dead-run review must not count)", () => {
    const queued = [{ kind: "review", runId: "r-dead" }];
    expect(queuedTasksReservingSlots(queued, new Set())).toEqual([]);
  });
});
