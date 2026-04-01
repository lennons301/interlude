import { db } from "@/db";
import { tasks, messages } from "@/db/schema";
import { eq } from "drizzle-orm";
import { newId } from "../ulid";
import { getDocker, isDockerAvailable } from "../docker/client";
import { startQueue } from "./queue";
import { isGitHubConfigured } from "../github/client";

let initialized = false;

async function recoverOrphanedTasks(): Promise<void> {
  const orphaned = await db
    .select({ id: tasks.id, containerName: tasks.containerName })
    .from(tasks)
    .where(eq(tasks.status, "running"));

  if (orphaned.length === 0) return;

  const now = new Date();
  for (const task of orphaned) {
    // Stop and remove the actual Docker container if it still exists
    if (task.containerName) {
      try {
        const docker = getDocker();
        const container = docker.getContainer(task.containerName);
        await container.remove({ force: true });
        console.log(`[orchestrator] Removed orphaned container: ${task.containerName}`);
      } catch {
        // Container already gone — fine
      }
    }

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

/**
 * Remove any interlude-task-* containers that have no matching active/running task in the DB.
 * Catches containers orphaned by crashes, incomplete cleanups, or stale deployments.
 */
async function reapStaleContainers(): Promise<void> {
  try {
    const docker = getDocker();
    const containers = await docker.listContainers({
      all: true,
      filters: { name: ["interlude-task-"] },
    });

    if (containers.length === 0) return;

    // Get all tasks that should have a live container
    const activeTasks = await db
      .select({ containerName: tasks.containerName })
      .from(tasks)
      .where(eq(tasks.status, "running"));

    const activeNames = new Set(activeTasks.map((t) => t.containerName).filter(Boolean));

    let reaped = 0;
    for (const info of containers) {
      // Docker returns names with leading slash
      const name = info.Names[0]?.replace(/^\//, "");
      if (!name || activeNames.has(name)) continue;

      try {
        const container = docker.getContainer(info.Id);
        await container.remove({ force: true });
        reaped++;
      } catch {
        // Already gone
      }
    }

    if (reaped > 0) {
      console.log(`[reaper] Removed ${reaped} stale container(s)`);
    }
  } catch (err) {
    console.error("[reaper] Error during container cleanup:", err);
  }
}

export async function initOrchestrator(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const dockerAvailable = await isDockerAvailable();
  if (dockerAvailable) {
    console.log("[orchestrator] Docker available, starting task queue");
    if (isGitHubConfigured()) {
      console.log("[orchestrator] GitHub App configured -- webhooks and PR creation enabled");
    } else {
      console.log("[orchestrator] GitHub App not configured -- running without GitHub integration");
    }
    await recoverOrphanedTasks();
    await reapStaleContainers();
    startQueue();

    // Run the reaper every 5 minutes to catch any leaked containers
    setInterval(() => reapStaleContainers().catch(console.error), 5 * 60 * 1000);
  } else {
    console.log(
      "[orchestrator] Docker not available, running in UI-only mode (mock agent still works)"
    );
  }
}
