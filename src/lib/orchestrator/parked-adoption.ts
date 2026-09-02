import type { AgentPassKind } from "../config";

/** What the daemon can say about a container: it is there, it is definitively
 * gone, or it did not answer. */
export type ContainerPresence = "present" | "absent" | "unknown";

/** The task-row facts adoption turns on. */
export interface ParkedTaskRow {
  taskId: string;
  runId: string | null;
  status: string;
  kind: AgentPassKind;
  containerName: string | null;
  containerId: string | null;
  previewSubdomain: string | null;
}

/** A parked container to put back in `activeTasks` as idle. */
export interface ParkedAdoption {
  taskId: string;
  runId: string | null;
  kind: AgentPassKind;
  containerName: string;
  containerId: string;
  previewSubdomain: string;
}

/** A parked task with nothing left to adopt. */
export interface OrphanedParkedTask {
  taskId: string;
  runId: string | null;
  reason: "container-gone" | "no-container-recorded";
}

export interface ParkedAdoptionPlan {
  adopt: ParkedAdoption[];
  orphaned: OrphanedParkedTask[];
  /** Task ids left blocked for a later boot: the daemon did not answer, and
   * unknown decides nothing in either direction. */
  deferred: string[];
}

export function planParkedAdoption(
  rows: ParkedTaskRow[],
  presence: (containerName: string) => ContainerPresence,
  alreadyAdopted: Iterable<string> = []
): ParkedAdoptionPlan {
  const held = new Set(alreadyAdopted);
  const adopt: ParkedAdoption[] = [];
  const orphaned: OrphanedParkedTask[] = [];
  const deferred: string[] = [];
  for (const row of rows) {
    // Only a parked task is adoptable, and only one nobody holds yet. Both
    // guards are the same guarantee from two sides: adoption may never
    // resurrect a task whose row has moved on, nor hand out a second handle to
    // a session already live in this process.
    if (row.status !== "blocked") continue;
    if (held.has(row.taskId)) continue;
    if (row.containerName == null || row.containerId == null) {
      orphaned.push({
        taskId: row.taskId,
        runId: row.runId,
        reason: "no-container-recorded",
      });
      continue;
    }
    const seen = presence(row.containerName);
    if (seen === "absent") {
      orphaned.push({ taskId: row.taskId, runId: row.runId, reason: "container-gone" });
      continue;
    }
    if (seen === "unknown") {
      deferred.push(row.taskId);
      continue;
    }
    adopt.push({
      taskId: row.taskId,
      runId: row.runId,
      kind: row.kind,
      containerName: row.containerName,
      containerId: row.containerId,
      previewSubdomain: row.previewSubdomain ?? "",
    });
  }
  return { adopt, orphaned, deferred };
}
