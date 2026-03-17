import { db } from "@/db";
import { tasks, messages } from "@/db/schema";
import { eq } from "drizzle-orm";
import { newId } from "../ulid";
import { isDockerAvailable } from "../docker/client";
import { startQueue } from "./queue";

let initialized = false;

async function recoverOrphanedTasks(): Promise<void> {
  const orphaned = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.status, "running"));

  if (orphaned.length === 0) return;

  const now = new Date();
  for (const task of orphaned) {
    await db
      .update(tasks)
      .set({
        status: "failed",
        containerId: null,
        containerStatus: null,
        updatedAt: now,
      })
      .where(eq(tasks.id, task.id));

    await db.insert(messages).values({
      id: newId(),
      taskId: task.id,
      role: "system",
      content: "Server restarted — task interrupted. You can re-queue this task.",
      type: "system",
      createdAt: now,
    });
  }

  console.log(
    `[orchestrator] Recovered ${orphaned.length} orphaned task(s) stuck in "running" status`
  );
}

export async function initOrchestrator(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const dockerAvailable = await isDockerAvailable();
  if (dockerAvailable) {
    console.log("[orchestrator] Docker available, starting task queue");
    await recoverOrphanedTasks();
    startQueue();
  } else {
    console.log(
      "[orchestrator] Docker not available, running in UI-only mode (mock agent still works)"
    );
  }
}
