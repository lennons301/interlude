/**
 * Task bookkeeping shared by the sweep, DB-only and side-effect-light so it is
 * unit-testable against an in-memory database (issues #95, #124).
 *
 * The exactly-one-review invariant — a run has *exactly one* review pass in
 * flight, never zero when one is owed, never two racing the same PR:
 *
 *  1. `inFlightReviewTaskId` — the idempotency rule. Before queueing a review
 *     pass, any review task for the same run that is still `queued` or
 *     `running` counts as in flight, so `decideNext` does not queue a second.
 *
 *  2. `reapDeadReviewTasks` — the ungraceful-death path. A review container
 *     OOM-killed or lost while the daemon hangs can leave its task stuck
 *     `running` with no status transition (observed in the 2026-08-04 incident,
 *     #93/#96). Keyed on task status alone, rule 1 would then read that dead
 *     pass as live forever: the run stalls, and any path that does re-queue
 *     races a duplicate. This marks such a task terminal (`failed`) once its
 *     container is confirmed gone, so the next sweep's rule-1 check queues one
 *     deliberate replacement rather than stalling or racing.
 *
 * The finalized-run cleanup (issue #124):
 *
 *  3. `cancelOrphanedRunTasks` — when a run reaches a terminal status, cancel
 *     any pass it still owns so nothing outlives its run.
 *  4. `queuedTasksReservingSlots` — the mirror on the read side: only a queued
 *     task whose run is still live reserves a slot for pickup accounting, so a
 *     task orphaned under a dead run can never wedge new claims.
 *
 * DB-only by design (no Docker/GitHub imports): the container-liveness probe
 * is injected so the sweep passes the real daemon check and tests pass a fake,
 * and cancelled tasks are returned so the caller — not this module — removes
 * their containers.
 */

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "@/db/schema";
import { messages, tasks } from "@/db/schema";
import { newId } from "../../ulid";

/** The injected database handle — the app singleton in the sweep, an
 * in-memory one in tests. Exported so both sides name the seam the same way. */
export type Db = BetterSQLite3Database<typeof schema>;

/**
 * The id of a review task for this run that is still in flight — `queued` or
 * `running` — or null if there is none. This is the check that keeps review
 * queueing idempotent across sweeps (issue #45, hardened by #95): while it
 * returns non-null, `decideNext` leaves `hasReviewTask` true and queues no
 * second pass. A dead-but-stuck-`running` task is only cleared by
 * `reapDeadReviewTasks` — until then it correctly reads as in flight here.
 */
export function inFlightReviewTaskId(db: Db, runId: string): string | null {
  const task = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.runId, runId),
        eq(tasks.kind, "review"),
        inArray(tasks.status, ["queued", "running"])
      )
    )
    .get();
  return task?.id ?? null;
}

/** A task some path terminalized — returned so the caller can drop its
 * in-memory session entry and remove any container it held. */
export interface TerminalizedTask {
  taskId: string;
  containerName: string | null;
}

/** @deprecated alias kept for the reaper's existing name — see
 * {@link TerminalizedTask}. */
export type ReapedReviewTask = TerminalizedTask;

/**
 * Mark review tasks stuck `running` whose container is gone as `failed`, the
 * ungraceful-death half of the exactly-one-review invariant (issue #95).
 *
 * `isContainerLive` is the injected liveness probe (the real Docker inspect in
 * the sweep, a fake in tests). Only a task whose container the probe reports
 * *not* live is reaped; a task still provisioning (no container name yet) and
 * any task whose probe is inconclusive are left alone, so a genuinely working
 * review pass is never terminalized out from under itself. Marking a review
 * task `failed` does not fail the run or consume an attempt — a review death is
 * infra, not bad work (cf. #97); it only frees rule 1 to queue one replacement.
 *
 * Returns the reaped tasks so the caller can remove their containers and clear
 * their session entries; the DB transition here is what the next sweep reads.
 */
export async function reapDeadReviewTasks(
  db: Db,
  isContainerLive: (containerName: string) => Promise<boolean>
): Promise<ReapedReviewTask[]> {
  const running = db
    .select({ id: tasks.id, containerName: tasks.containerName })
    .from(tasks)
    .where(and(eq(tasks.kind, "review"), eq(tasks.status, "running")))
    .all();

  const reaped: ReapedReviewTask[] = [];
  for (const task of running) {
    // No container name yet: the row went `running` before its container was
    // created (startTask sets the status first). It is provisioning, not dead.
    if (!task.containerName) continue;
    if (await isContainerLive(task.containerName)) continue;

    const now = new Date();
    db.update(tasks)
      .set({ status: "failed", containerId: null, containerStatus: null, updatedAt: now })
      .where(eq(tasks.id, task.id))
      .run();
    db.insert(messages)
      .values({
        id: newId(),
        taskId: task.id,
        role: "system",
        type: "system",
        content: JSON.stringify({
          text:
            "Review pass container was lost (OOM / daemon error) with the task " +
            "still marked running — marking it failed so a single replacement " +
            "review can be queued.",
        }),
        createdAt: now,
      })
      .run();

    reaped.push({ taskId: task.id, containerName: task.containerName });
  }
  return reaped;
}

/**
 * Terminalize every task a run still owns that is `queued` or `running`,
 * setting it `cancelled` — the shared cleanup called from every run-
 * finalization point (issue #124). When a run reaches a terminal status — its
 * PR merged or closed, or the run failed/exhausted — any pass it still owns
 * must not outlive it. The classic orphan is a review task left `queued`
 * because the single slot was busy when a human merged the gated PR by hand:
 * the run finalized to `merged`, but its queued review sat non-terminal
 * forever, read as a reserved slot by the claim accounting, and wedged all
 * new pickup (the LPS #135 incident).
 *
 * `cancelled` (not `failed`) by design: an orphaned pass is abandoned, not bad
 * work, so it consumes no attempt — matching how a user-cancelled task and a
 * restart-interrupted run's queued pass are handled (init.ts). A parked
 * implement/repair container is released to `completed` by its own path
 * *before* this runs, so this only sweeps up the genuinely-orphaned tasks;
 * anything already terminal is skipped by the status filter. `blocked` is
 * swept too (not just `queued`/`running`) so the invariant is total — no task
 * in any non-terminal status outlives its run.
 *
 * DB-only: returns the cancelled tasks with their container names so the
 * caller removes any container that was still live, exactly like
 * `reapDeadReviewTasks`. (A `queued` orphan has no container; a `running` one —
 * a review pass a hand-merge raced — or a `blocked` one's parked container
 * carries a name to clean up.)
 */
export function cancelOrphanedRunTasks(db: Db, runId: string): TerminalizedTask[] {
  const orphaned = db
    .select({ id: tasks.id, containerName: tasks.containerName, kind: tasks.kind })
    .from(tasks)
    .where(and(eq(tasks.runId, runId), inArray(tasks.status, ["queued", "running", "blocked"])))
    .all();

  const cancelled: TerminalizedTask[] = [];
  const now = new Date();
  for (const task of orphaned) {
    db.update(tasks)
      .set({ status: "cancelled", containerId: null, containerStatus: null, updatedAt: now })
      .where(eq(tasks.id, task.id))
      .run();
    db.insert(messages)
      .values({
        id: newId(),
        taskId: task.id,
        role: "system",
        type: "system",
        content: JSON.stringify({
          text:
            `Run finalized while this ${task.kind} pass had not terminalized — ` +
            "cancelling it so no task outlives its run (issue #124).",
        }),
        createdAt: now,
      })
      .run();
    cancelled.push({ taskId: task.id, containerName: task.containerName });
  }
  return cancelled;
}

/**
 * The queued tasks that reserve a slot for new-pickup accounting (issue #124):
 * a task counts only if its run is still live, or it has no run at all
 * (interactive and triage passes, which are real queued intent, never a dead
 * run's ghost). `liveRunIds` is the set of run IDs in a non-terminal status
 * (`ACTIVE_RUN_STATUSES`). A task orphaned under a finalized run — the queued
 * review left behind by a hand-merged PR — is excluded, so it can never force
 * `claimableSlots` to 0 and halt the frontier while a slot sits free. This is
 * the read-side mirror of `cancelOrphanedRunTasks`: even if a finalization
 * point were ever missed, a dead-run task still cannot suppress a claim.
 */
export function queuedTasksReservingSlots<T extends { runId: string | null }>(
  queuedTasks: readonly T[],
  liveRunIds: ReadonlySet<string>
): T[] {
  return queuedTasks.filter((t) => t.runId == null || liveRunIds.has(t.runId));
}
