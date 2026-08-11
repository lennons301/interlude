import { db } from "@/db";
import { tasks, messages } from "@/db/schema";
import { eq, and, isNull, asc, sql } from "drizzle-orm";
import { startTask } from "./turn-manager";
import { getActiveTasks, isParked, processQueuedMessages, scanForDevServer } from "./turn-manager";
import {
  createLocalCapacityProvider,
  getCapacity,
  checkMemoryAdmission,
  type CapacityProvider,
} from "./capacity";

let pollInterval: ReturnType<typeof setInterval> | null = null;
let pollCount = 0;

/** Track which tasks are currently being processed to prevent double-dispatch */
const processingTasks = new Set<string>();

let capacityProvider: CapacityProvider | null = null;
let saturationLogged = false;

/**
 * Slots in use: live containers plus pickups still provisioning theirs
 * (a task sits in processingTasks before it registers in activeTasks —
 * without counting those, back-to-back polls could overfill the box).
 * Parked autonomous containers (an implement pass idling while its PR is
 * reviewed) run no agent process and hold no slot — see isParked.
 */
export function occupiedSlots(): number {
  const active = getActiveTasks();
  let count = 0;
  for (const entry of active.values()) {
    if (!isParked(entry)) count++;
  }
  for (const taskId of processingTasks) {
    if (!active.has(taskId)) count++;
  }
  return count;
}

export function startQueue(): void {
  if (pollInterval) return;

  console.log("[orchestrator] Queue started, polling every 2s");

  pollInterval = setInterval(async () => {
    try {
      pollCount++;

      // 1. Pick up new queued tasks — through the capacity provider seam,
      // never a direct Docker query at the call site. Interactive tasks the
      // owner dispatched outrank queued autonomous passes for the next slot
      // (issue #15); review passes outrank the rest because they finish
      // in-flight work rather than starting more (issue #17); triage passes
      // outrank implements because shaping the backlog is cheap and new
      // issues get met on arrival (issue #23); within a kind, oldest first.
      const next = db
        .select()
        .from(tasks)
        .where(eq(tasks.status, "queued"))
        .orderBy(
          sql`case ${tasks.kind} when 'interactive' then 0 when 'review' then 1 when 'triage' then 2 else 3 end`,
          asc(tasks.createdAt)
        )
        .get();

      if (next && !processingTasks.has(next.id)) {
        if (!capacityProvider) {
          capacityProvider = createLocalCapacityProvider(
            await getCapacity(),
            occupiedSlots
          );
        }

        // The slot count gates concurrency; the memory-admission probe is the
        // backstop against overcommit (issue #93) — it asks the daemon what is
        // actually running, catching any drift the slot bookkeeping missed
        // before the host OOMs. Both must clear before a task starts.
        const slotFree = await capacityProvider.isSlotAvailable();
        if (!slotFree) {
          if (!saturationLogged) {
            saturationLogged = true;
            console.log(
              `[orchestrator] All ${capacityProvider.capacity.slots} slot(s) busy — task ${next.id} waits in queue`
            );
          }
        } else {
          // Reserve the task before probing. The probe can now block for up to
          // ADMISSION_PROBE_TIMEOUT_MS on a slow or hung daemon (issue #125) —
          // longer than the 2s poll interval — so without reserving first, an
          // overlapping poll would still see this task queued, clear its own
          // slot check, and dispatch it a second time: two containers for one
          // task, the exact overcommit #93 guards against. Reserving also caps
          // the probe to one in-flight call per free slot, since a full box
          // short-circuits above without probing. Released again if the probe
          // refuses the start.
          processingTasks.add(next.id);
          const admission = await checkMemoryAdmission();
          if (admission.ok) {
            saturationLogged = false;
            console.log(
              `[orchestrator] Picked up task: ${next.id} — ${next.title}`
            );
            startTask(next.id)
              .catch((err) =>
                console.error(`[orchestrator] Task ${next.id} failed:`, err)
              )
              .finally(() => processingTasks.delete(next.id));
          } else {
            processingTasks.delete(next.id);
            if (!saturationLogged) {
              saturationLogged = true;
              console.log(
                `[orchestrator] Memory headroom low (${admission.reason}) — task ${next.id} waits in queue`
              );
            }
          }
        }
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
          // A parked autonomous container is stopped to free memory (#93) —
          // execing a port scan into it would fail, and its dev server is not
          // a live preview concern anyway. Only interactive idle sessions are
          // scanned.
          if (isParked(entry)) continue;
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
