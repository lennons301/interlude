/**
 * Review-pass task bookkeeping shared by the sweep (issue #95).
 *
 * Two mechanisms that must work together so a run has *exactly one* review
 * pass in flight — never zero when one is owed, never two racing the same PR:
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
 * DB-only by design (no Docker/GitHub imports): the container-liveness probe
 * is injected so the sweep passes the real daemon check and tests pass a fake.
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

/** A review task the reaper terminalized — returned so the caller can drop its
 * in-memory session entry and remove the dead container. */
export interface ReapedReviewTask {
  taskId: string;
  containerName: string | null;
}

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
