import { db } from "@/db";
import { tasks, messages } from "@/db/schema";
import { eq, and, isNull, asc, ne, sql } from "drizzle-orm";
import { readLaneCrossing } from "../lanes/overflow-state";
import { noteOnceOnFeed } from "../tasks/feed-note";
import { startTask } from "./turn-manager";
import {
  abandonSessionWithoutContainer,
  getActiveTasks,
  isParked,
  processQueuedMessages,
  pruneTerminalActiveTasks,
  scanForDevServer,
} from "./turn-manager";
// The one predicate for "this task has stopped for good", shared with the turn
// manager rather than restated here — a fleet that disagreed with itself about
// whether a task had finished is how bookkeeping came to outlive its task twice.
import { storedTaskStatus, taskIsFinished } from "../tasks/stored-status";
import { observeContainerAbsent } from "../docker/container-manager";
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

/**
 * Slots in use: live containers plus pickups still provisioning theirs.
 * Parked autonomous containers (an implement pass idling while its PR is
 * reviewed) run no agent process and hold no slot — see isParked.
 *
 * Nothing a *finished* task once held is counted, whichever set holds it. A
 * reservation for a finished task stands in for nothing: its container is gone
 * and no pickup is provisioning one (issue #151) — that is what wedged the box
 * on 2026-08-18, a reservation whose driving promise hung on an unbounded GitHub
 * call so its `.finally()` release never ran, while the task it covered
 * completed and took its container with it. A session entry for a finished task
 * is the same lie from the other side (issue #159): it claims an agent process
 * that cannot exist, and on a one-slot box it held all pickup — interactive and
 * autonomous alike — until the app was restarted.
 *
 * So the task row, not the bookkeeping, decides: reading it makes the count
 * self-heal within one poll however the entry came to be stranded. The reading
 * is a handful of indexed lookups over at most a couple of ids, and this is the
 * value that gates every dispatch, so it is worth paying every poll.
 * `releaseSpentReservations` then lets go of what this skipped.
 */
export function occupiedSlots(): number {
  const active = getActiveTasks();
  let count = 0;
  for (const [taskId, entry] of active) {
    if (isParked(entry)) continue;
    if (taskIsFinished(taskId)) continue;
    count++;
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
 *   process;
 * - a session entry ends with its task (issue #159). Every terminal path
 *   deletes its own, so anything left here is bookkeeping that went astray —
 *   and until it goes, `occupiedSlots` has already stopped counting it.
 */
function releaseSpentReservations(): void {
  const active = getActiveTasks();
  for (const taskId of slotReservations) {
    if (active.has(taskId) || taskIsFinished(taskId)) slotReservations.delete(taskId);
  }
  for (const taskId of inFlightTasks) {
    if (taskIsFinished(taskId)) inFlightTasks.delete(taskId);
  }
  for (const taskId of pruneTerminalActiveTasks()) {
    console.warn(
      `[orchestrator] Dropped stranded session entry for finished task ${taskId} — ` +
        `it was holding a slot with no agent process behind it (issue #159)`
    );
  }
}

/** How often the reconciliation below runs, in poll cycles — ~32s at the 2s
 * poll. A saturated box is the *normal* state on a one-slot machine, so per-poll
 * probing would ask Docker about every occupant every 2s forever, and the wedges
 * this clears lasted 20 minutes and more. Deliberately not the port scan's 15,
 * so the two do not land on the same tick for the life of the process. */
const RECONCILE_EVERY_POLLS = 16;

/**
 * When pickup is blocked, ask the daemon whether the containers behind those
 * slots exist — and give up on the sessions whose do not (issue #159). Returns
 * whether a slot was freed, so the caller can re-check before giving up on the
 * cycle.
 *
 * This is the check the queue already owned and never ran. The memory-admission
 * probe is the one place that asks Docker what is really there, but it sat
 * behind `slotFree`, so a *phantom* slot failed the slot test first and the
 * probe never ran: it could only ever catch under-counting drift, never
 * over-counting. Which is the wrong way round for a wedge — over-counting is
 * what stops work starting.
 *
 * One-directional and fail-safe throughout, because freeing a slot out from
 * under live work is worse than the wedge it fixes: a session goes only when the
 * daemon *positively* answers 404 for its container. Unknown decides nothing
 * (see `observeContainerAbsent`), and parked passes are not even asked about —
 * they hold no slot, so there is nothing to reclaim.
 *
 * Releasing the slot is not the whole job: the task is recorded `failed` too, or
 * it would linger `running` with no container — counted by the dashboard,
 * uncounted by the queue, which is the disagreement this ticket was about. When
 * a run owns the task that accounting belongs to the run's own recovery paths
 * (#95, #97, #106), so those keep both their entry and their slot and this only
 * says what it saw.
 *
 * Terminal tasks never get here: they are released without asking anyone (see
 * `occupiedSlots`), so this only ever looks at tasks the DB still calls live.
 */
async function reconcileSlotsAgainstDaemon(): Promise<boolean> {
  let released = false;

  for (const [taskId, entry] of getActiveTasks()) {
    // Parked passes hold no slot, and their container is `docker stop`ped by
    // design (#93) — nothing to reclaim, nothing to suspect.
    if (isParked(entry)) continue;
    if (taskIsFinished(taskId)) continue;

    const absent = await observeContainerAbsent(entry.container.name);
    if (absent !== true) continue;

    const status = storedTaskStatus(taskId) ?? "gone";
    const reason = `its container (${entry.container.name}) is no longer known to Docker`;
    if (!abandonSessionWithoutContainer(taskId, reason)) {
      console.warn(
        `[orchestrator] Task ${taskId} is '${status}' but ${reason} — leaving its ` +
          `slot held: it belongs to a run, whose own recovery owns this (issue #159)`
      );
      continue;
    }

    released = true;
    console.warn(
      `[orchestrator] Freed the slot held by task ${taskId} and failed it: it was ` +
        `'${status}' and ${reason} (issue #159)`
    );
  }

  return released;
}

/**
 * The head of the queue: interactive tasks the owner dispatched first (issue
 * #15), then review passes (they finish in-flight work rather than starting
 * more — issue #17), then triage (shaping the backlog is cheap and new issues
 * get met on arrival — issue #23), then implements; oldest first within a
 * kind.
 *
 * `skipInteractive` is issue #173's hold: the same ordering over everything
 * else, so the kind that cannot start is stepped over rather than starving
 * the rest.
 */
function nextQueuedTask(skipInteractive: boolean) {
  return db
    .select()
    .from(tasks)
    .where(
      skipInteractive
        ? and(eq(tasks.status, "queued"), ne(tasks.kind, "interactive"))
        : eq(tasks.status, "queued")
    )
    .orderBy(
      sql`case ${tasks.kind} when 'interactive' then 0 when 'review' then 1 when 'triage' then 2 else 3 end`,
      asc(tasks.createdAt)
    )
    .get();
}

/**
 * Whether the money guards refuse to let an attended session start (issue
 * #173), telling the human why on the task's own feed.
 *
 * The refusal is the crossing's, evaluated through the one function the turn
 * manager routes a pass with and the task screen offers the confirmation
 * from, so the queue can never decline a pass the screen says is fine. Only
 * the task at the head is told: it is the one that would have started, and
 * every other queued session gets its own line when it gets there — a note
 * per queued task per poll would be a message storm on a fleet that is walled
 * for five hours.
 *
 * The task is left `queued`, not failed: a confirmation is a press away and
 * the cap lifts itself at midnight, so there is work here to start rather
 * than work to abandon.
 */
function attendedPickupIsHeld(taskId: string): boolean {
  const { refusal } = readLaneCrossing("interactive");
  if (refusal === null) return false;

  if (noteOnceOnFeed(taskId, refusal.message)) {
    console.log(
      `[orchestrator] Task ${taskId} waits in queue — ${refusal.reason} (issue #173)`
    );
  }
  return true;
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
      let next = nextQueuedTask(false);

      // An attended session the money guards refuse must not start — and must
      // not sit at the head of the queue holding everything behind it either
      // (issue #173). Interactive work sorts first, so a fleet waiting on one
      // press would otherwise stop starting the review passes and resumes that
      // finish work already paid for. The hold is fleet-wide for interactive
      // passes, so skipping the whole kind is exactly the right width; the
      // task stays `queued` and starts on the poll after the press.
      if (next?.kind === "interactive" && attendedPickupIsHeld(next.id)) {
        next = nextQueuedTask(true);
      }

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
        let slotFree = await capacityProvider.isSlotAvailable();
        // A blocked pickup is the one verdict worth double-checking, because it
        // is the one that stops work (issue #159). Periodically rather than
        // every poll: on a one-slot box "busy" is the normal reading, and the
        // wedges this clears last minutes.
        if (!slotFree && pollCount % RECONCILE_EVERY_POLLS === 0) {
          if (await reconcileSlotsAgainstDaemon()) {
            slotFree = await capacityProvider.isSlotAvailable();
          }
        }
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
        // A task that has stopped is never a delivery target, whatever its
        // entry still says. Terminal paths delete the entry as they go, but a
        // status written without one (a reaped review, a boot sweep) would
        // otherwise leave a stranded entry being drained every poll — which
        // starts and stops a parked container for a turn that breaks
        // immediately (issue #151).
        if (taskIsFinished(taskId)) continue;

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
