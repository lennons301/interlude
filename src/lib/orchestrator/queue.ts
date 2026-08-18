import { db } from "@/db";
import { tasks, messages } from "@/db/schema";
import { eq, and, isNull, asc, sql } from "drizzle-orm";
import { startTask } from "./turn-manager";
import { getActiveTasks, isParked, processQueuedMessages, scanForDevServer } from "./turn-manager";
// The one predicate for "this task has stopped for good", shared with the live
// view rather than restated here.
import { isTerminalTaskStatus } from "../chat/composer";
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

/**
 * Tasks whose dispatch or delivery promise is in flight — the re-entrancy lock
 * that stops one poll picking up a task another already did, or delivering a
 * follow-up turn into a container whose current turn is still finishing. It is
 * released when the driving promise settles, which is the earliest safe moment:
 * `startTask` marks its container idle *before* it commits, pushes and opens the
 * PR, so letting go sooner would run two agent execs in one container.
 *
 * Deliberately not what the slot count reads — see `slotReservations`. Those
 * were one set until issue #151, and conflating a lock (held as long as a
 * promise runs) with a slot reservation (held only while a container is being
 * provisioned) is how a hung promise came to wedge the whole box.
 */
const inFlightTasks = new Set<string>();

/**
 * Pickups that have not registered a container yet — the only reservation
 * `occupiedSlots` counts. It stands in for a container being provisioned, so
 * back-to-back polls cannot overfill the box before `activeTasks` knows about
 * it, and it is released the moment that provisioning ends: the task registers
 * its container, or its status turns terminal without one
 * (`releaseSpentReservations`). Never waits on `startTask`'s promise to settle
 * (issue #151).
 */
const slotReservations = new Set<string>();

let capacityProvider: CapacityProvider | null = null;
let saturationLogged = false;

/** The task's stored status, or null when its row is gone — the authority on
 * whether a task is still live, independent of any in-memory bookkeeping. */
function storedTaskStatus(taskId: string): string | null {
  return (
    db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).get()
      ?.status ?? null
  );
}

/** Has the task stopped for good — or gone entirely? Either way nothing it
 * once held can still be in use. */
function taskIsFinished(taskId: string): boolean {
  const status = storedTaskStatus(taskId);
  return status === null || isTerminalTaskStatus(status);
}

/**
 * Slots in use: live containers plus pickups still provisioning theirs.
 * Parked autonomous containers (an implement pass idling while its PR is
 * reviewed) run no agent process and hold no slot — see isParked.
 *
 * A reservation for a task that has *finished* stands in for nothing: its
 * container is gone and no pickup is provisioning one, so it is never counted
 * (issue #151). That is what wedged the box on 2026-08-18 — a reservation whose
 * driving promise hung on an unbounded GitHub call, so the `.finally()` release
 * never ran, while the task it covered completed and took its container with
 * it. Reading the task's status rather than trusting the reservation makes the
 * count self-heal within one poll.
 */
export function occupiedSlots(): number {
  const active = getActiveTasks();
  let count = 0;
  for (const entry of active.values()) {
    if (!isParked(entry)) count++;
  }
  for (const taskId of slotReservations) {
    if (active.has(taskId)) continue;
    if (taskIsFinished(taskId)) continue;
    count++;
  }
  return count;
}

/**
 * Let go of everything a poll no longer needs to hold (issue #151). Run at the
 * top of each cycle, so neither set can outlive the task it refers to even when
 * the promise that created it never settles:
 *
 * - a slot reservation ends when its container registers in `activeTasks` —
 *   the entry is the occupant from then on — or when the task finishes without
 *   one;
 * - the in-flight lock outlives provisioning by design, but not its task: a
 *   finished task can neither be picked up again (pickup reads `queued` only)
 *   nor delivered into (its `activeTasks` entry is gone), so a lock left behind
 *   by a hung promise protects nothing and would sit there for the life of the
 *   process.
 */
function releaseSpentReservations(): void {
  const active = getActiveTasks();
  for (const taskId of slotReservations) {
    if (active.has(taskId) || taskIsFinished(taskId)) slotReservations.delete(taskId);
  }
  for (const taskId of inFlightTasks) {
    if (taskIsFinished(taskId)) inFlightTasks.delete(taskId);
  }
}

export function startQueue(): void {
  if (pollInterval) return;

  console.log("[orchestrator] Queue started, polling every 2s");
  // Seed the heartbeat so a freshly-started loop is not immediately "stale".
  lastProgressAt = new Date();

  pollInterval = setInterval(async () => {
    try {
      pollCount++;

      // Reservations first: a slot reservation whose container has registered,
      // and any bookkeeping left behind by a promise that never settled, must
      // not gate this cycle's dispatch (issue #151).
      releaseSpentReservations();

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

      if (next && !inFlightTasks.has(next.id)) {
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
          inFlightTasks.add(next.id);
          slotReservations.add(next.id);
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
              // The lock's own release; for the slot reservation this is only a
              // backstop — `releaseSpentReservations` normally let go of it back
              // when the container registered.
              .finally(() => {
                inFlightTasks.delete(next.id);
                slotReservations.delete(next.id);
              });
          } else {
            inFlightTasks.delete(next.id);
            slotReservations.delete(next.id);
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
        if (inFlightTasks.has(taskId)) continue;

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
          // A delivery takes the lock but no slot reservation: the container it
          // resumes is already registered in `activeTasks`, which is what counts
          // it. Reserving a slot here is what made a hung delivery a phantom
          // occupant once its task completed and took that entry away (#151).
          inFlightTasks.add(taskId);
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
            .finally(() => inFlightTasks.delete(taskId));
        }
      }

      // 3. Periodic dev server port scan for idle tasks (every ~30s = 15 poll cycles)
      if (pollCount % 15 === 0) {
        for (const [taskId, entry] of activeTasks) {
          if (entry.state !== "idle") continue;
          if (inFlightTasks.has(taskId)) continue;
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
