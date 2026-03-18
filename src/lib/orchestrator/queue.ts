import { db } from "@/db";
import { tasks, messages } from "@/db/schema";
import { eq, and, isNull, asc } from "drizzle-orm";
import { startTask } from "./turn-manager";
import { getActiveTasks, processQueuedMessages, scanForDevServer } from "./turn-manager";

let pollInterval: ReturnType<typeof setInterval> | null = null;
let pollCount = 0;

/** Track which tasks are currently being processed to prevent double-dispatch */
const processingTasks = new Set<string>();

export function startQueue(): void {
  if (pollInterval) return;

  console.log("[orchestrator] Queue started, polling every 2s");

  pollInterval = setInterval(async () => {
    try {
      pollCount++;

      // 1. Pick up new queued tasks
      const next = db
        .select()
        .from(tasks)
        .where(eq(tasks.status, "queued"))
        .orderBy(asc(tasks.createdAt))
        .get();

      if (next && !processingTasks.has(next.id)) {
        processingTasks.add(next.id);
        console.log(
          `[orchestrator] Picked up task: ${next.id} — ${next.title}`
        );
        startTask(next.id)
          .catch((err) =>
            console.error(`[orchestrator] Task ${next.id} failed:`, err)
          )
          .finally(() => processingTasks.delete(next.id));
      }

      // 2. Check idle tasks for queued messages
      const activeTasks = getActiveTasks();
      for (const [taskId, entry] of activeTasks) {
        if (entry.state !== "idle") continue;
        if (processingTasks.has(taskId)) continue;

        // Check for undelivered user messages
        const queued = db
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.taskId, taskId),
              eq(messages.role, "user"),
              isNull(messages.deliveredAt)
            )
          )
          .orderBy(asc(messages.createdAt))
          .get();

        if (queued) {
          processingTasks.add(taskId);
          console.log(
            `[orchestrator] Resuming task ${taskId} with queued message`
          );
          processQueuedMessages(taskId, entry.container)
            .catch((err) =>
              console.error(
                `[orchestrator] Resume failed for ${taskId}:`,
                err
              )
            )
            .finally(() => processingTasks.delete(taskId));
        }
      }

      // 3. Periodic dev server port scan for idle tasks (every ~30s = 15 poll cycles)
      if (pollCount % 15 === 0) {
        for (const [taskId, entry] of activeTasks) {
          if (entry.state !== "idle") continue;
          if (processingTasks.has(taskId)) continue;
          scanForDevServer(taskId, entry.container).catch(console.error);
        }
      }
    } catch (err) {
      console.error("[orchestrator] Queue poll error:", err);
    }
  }, 2000);
}

export function stopQueue(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

export function isQueueRunning(): boolean {
  return pollInterval !== null;
}
