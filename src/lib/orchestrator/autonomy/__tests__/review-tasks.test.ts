import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb } from "@/test/create-test-db";
import { inFlightReviewTaskId, reapDeadReviewTasks } from "../review-tasks";
import { decideNext, passOutcomeSnapshot, type AutonomySnapshot } from "../decide";

type Db = ReturnType<typeof createTestDb>["db"];

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
