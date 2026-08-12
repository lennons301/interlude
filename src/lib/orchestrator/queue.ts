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
/** Last time a poll cycle ran to completion — the queue-loop heartbeat (issue
 * #126). Stamped at the END of each cycle so that a cycle which hangs on an
 * un-returned await (the #125 daemon-freeze shape) never advances it, letting
 * the sweep's watchdog see the loop stop making progress. A healthy idle loop
 * still finishes its cycle every 2s, so an idle fleet keeps this fresh and never
 * false-alarms. Null while the loop is stopped (boot/shutdown, not a wedge). */
let lastProgressAt: Date | null = null;

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
  // Seed the heartbeat so a freshly-started loop is not immediately "stale".
  lastProgressAt = new Date();

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

      // Heartbeat: the cycle completed. Reached only on a clean pass, so a hung
      // await (a wedged dispatch path) or a run of consecutive poll errors leaves
      // it stale for the watchdog; an idle-but-alive loop stamps it every 2s.
      lastProgressAt = new Date();
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
  lastProgressAt = null;
}

export function isQueueRunning(): boolean {
  return pollInterval !== null;
}

/** The queue poll loop's last completed-cycle time, or null when the loop is
 * stopped or has not finished its first tick — the heartbeat the fleet-health
 * watchdog reads (issue #126). See {@link lastProgressAt}. */
export function getQueueLastProgress(): Date | null {
  return lastProgressAt;
}
