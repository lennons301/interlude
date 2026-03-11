import { db } from "@/db";
import { tasks } from "@/db/schema";
import { eq, asc } from "drizzle-orm";
import { runTask } from "./task-runner";

let running = false;
let pollInterval: ReturnType<typeof setInterval> | null = null;

export function startQueue(): void {
  if (pollInterval) return;

  console.log("[orchestrator] Queue started, polling every 2s");

  pollInterval = setInterval(async () => {
    if (running) return; // One task at a time

    const next = db
      .select()
      .from(tasks)
      .where(eq(tasks.status, "queued"))
      .orderBy(asc(tasks.createdAt))
      .get();

    if (!next) return;

    running = true;
    console.log(`[orchestrator] Picked up task: ${next.id} — ${next.title}`);

    try {
      await runTask(next.id);
    } catch (err) {
      console.error(`[orchestrator] Task ${next.id} failed:`, err);
    } finally {
      running = false;
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
  return running;
}
