/**
 * What the *task row* says, for the orchestrator's in-memory bookkeeping to
 * check itself against.
 *
 * The stored status is the authority on whether a task is still live, and
 * reading it is how the slot count self-heals: `occupiedSlots` trusts neither a
 * reservation (issue #151) nor an `activeTasks` entry (issue #159) that its own
 * task row says has finished. It lives here rather than beside either caller
 * because both the queue and the turn manager need the same answer, and the turn
 * manager cannot import the queue — the queue imports it.
 *
 * Server-only: it touches the DB, so it is deliberately separate from the pure
 * {@link isTerminalTaskStatus} in `./status`, which a client component imports.
 */

import { db } from "@/db";
import { tasks } from "@/db/schema";
import { eq } from "drizzle-orm";
import { isTerminalTaskStatus } from "./status";

/** The task's stored status, or null when its row is gone — the authority on
 * whether a task is still live, independent of any in-memory bookkeeping. */
export function storedTaskStatus(taskId: string): string | null {
  return (
    db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).get()
      ?.status ?? null
  );
}

/** Has the task stopped for good — or gone entirely? Either way nothing it
 * once held can still be in use. */
export function taskIsFinished(taskId: string): boolean {
  const status = storedTaskStatus(taskId);
  return status === null || isTerminalTaskStatus(status);
}

/**
 * The container the task has on record, or null when it has none yet (or none
 * any more). `startTask` writes it immediately after the container is created,
 * so its absence is how the queue tells a pickup still provisioning from one
 * whose provisioning never finished (issue #159).
 */
export function storedTaskContainerId(taskId: string): string | null {
  return (
    db
      .select({ containerId: tasks.containerId })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .get()?.containerId ?? null
  );
}
