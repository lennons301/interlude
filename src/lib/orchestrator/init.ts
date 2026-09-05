import { db } from "@/db";
import { tasks, messages, runs } from "@/db/schema";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { newId } from "../ulid";
import { getDocker, isDockerAvailable } from "../docker/client";
import { AGENT_CONTAINER_NAME_PREFIX } from "../docker/agent-containers";
import { observeContainerAbsent } from "../docker/container-manager";
import { adoptParkedContainer, getActiveTasks } from "./turn-manager";
import {
  planParkedAdoption,
  type ContainerPresence,
  type OrphanedParkedTask,
} from "./parked-adoption";
import { commentOnIssue } from "../github/issues";
import { startQueue } from "./queue";
import { getCapacity } from "./capacity";
import { startAutonomySweeps } from "./autonomy/sweep";
import { ACTIVE_RUN_STATUSES, RECLAIMABLE_RUN_STATUSES } from "./run-status";
import { pruneTranscripts } from "../quota/session-transcript";
import { startPreflightRefresh } from "./autonomy/preflight";
import { startDailyDigest } from "./digest-schedule";
import { getConfig } from "../config";
import { reportLaneAvailability } from "../lanes/availability-report";
import { isGlobalAutonomyPaused } from "../settings";
import { isGitHubConfigured } from "../github/client";
import { isDiscordConfigured, startDiscordBot } from "../discord/client";

let initialized = false;

/**
 * Restart recovery for the runs ledger (issue #24): a run that was being
 * actively worked when the process died lost its containers' exec streams
 * with it. Mark it `interrupted` — a separate ledger outcome from `failed`,
 * so the sweep re-claims the ticket without consuming an attempt: the
 * platform's downtime is never charged to the ticket, work already pushed
 * to the branch survives, and only the in-flight turn is lost. The re-claim
 * is bounded by decideNext's interruption accounting.
 *
 * A `reviewing` run whose parsed verdict is already stored is left alone —
 * acting on the verdict after a restart is exactly why it is stored on the
 * run — and `gated`/`blocked` runs are waiting on a human, and `rate_limited`
 * ones (issue #168) on a clock, not on a lost turn, so re-running their
 * implement pass would buy nothing. Which statuses those are is
 * RECLAIMABLE_RUN_STATUSES' business, not this function's.
 *
 * Must run before recoverOrphanedTasks, which rewrites the `running` task
 * statuses this reads.
 */
async function markInterruptedRuns(): Promise<void> {
  const activeRuns = await db
    .select()
    .from(runs)
    .where(inArray(runs.status, [...RECLAIMABLE_RUN_STATUSES]));

  const now = new Date();
  for (const run of activeRuns) {
    if (run.reviewResult != null) continue;

    const owned = await db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.runId, run.id));
    if (!owned.some((t) => t.status === "running")) continue;

    await db
      .update(runs)
      .set({
        status: "interrupted",
        interruptionCount: run.interruptionCount + 1,
        finishedAt: now,
      })
      .where(eq(runs.id, run.id));

    // A queued task of an interrupted run (say, its review pass) must not
    // start against an abandoned attempt — the re-claim queues its own.
    // Clear container_status alongside the terminal status so the row can
    // never later read as a live session (issue #46).
    await db
      .update(tasks)
      .set({ status: "cancelled", containerStatus: null, updatedAt: now })
      .where(and(eq(tasks.runId, run.id), eq(tasks.status, "queued")));

    console.log(
      `[orchestrator] Run ${run.id} (${run.githubIssue}) interrupted by restart — ` +
        `the sweep will re-claim without consuming an attempt`
    );
  }
}

/**
 * Boot reconciliation for dangling runs (issue #106): before the pass-
 * completion path was fixed, a run whose implement pass finished with no PR
 * and no `BLOCKED:` question was left in `implementing`/`reviewing` with all
 * its tasks already terminal — nothing drives it forward, so it renders as a
 * permanent ghost `running` card on the fleet dashboard (`slots.used = 0`, no
 * container). markInterruptedRuns skips it (it owns no `running` task) and the
 * sweep never re-claims it (its run is still "active"), so it never self-heals.
 * Finalize any such run to `failed` here so pre-existing ghosts clear on the
 * next boot without a manual DB nudge.
 *
 * Deliberately narrow, so a run that is legitimately mid-flight is never
 * touched:
 * - `gated`/`blocked` runs are waiting on a human, not dangling — left alone,
 *   exactly as markInterruptedRuns leaves them.
 * - a stored `reviewResult` is left for the verdict path, as markInterruptedRuns
 *   does — acting on the verdict after a restart is why it is stored.
 * - a run holding a PR has something to gate/review/merge and the sweep
 *   advances it, so only PR-less runs qualify.
 * - a run that still owns a queued/running/blocked task will be resumed by the
 *   queue (or was just handled by markInterruptedRuns), so only runs whose
 *   tasks are all terminal (or which own none at all) qualify.
 *
 * Runs after markInterruptedRuns, whose running-task cases this must not
 * re-handle.
 */
async function finalizeDanglingRuns(): Promise<void> {
  const candidates = await db
    .select()
    .from(runs)
    .where(inArray(runs.status, [...RECLAIMABLE_RUN_STATUSES]));

  const now = new Date();
  for (const run of candidates) {
    if (run.reviewResult != null) continue;
    if (run.pullRequestNumber != null) continue;

    const owned = await db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.runId, run.id));
    // Anything still live (or queued to go live) will advance this run — only
    // an all-terminal (or task-less) run is genuinely dangling.
    if (
      owned.some(
        (t) => t.status === "running" || t.status === "blocked" || t.status === "queued"
      )
    ) {
      continue;
    }

    await db
      .update(runs)
      .set({
        status: "failed",
        failureReason:
          "dangling run reconciled at boot: implement pass left no PR and no open question (issue #106)",
        finishedAt: now,
      })
      .where(eq(runs.id, run.id));

    console.log(
      `[orchestrator] Run ${run.id} (${run.githubIssue}) finalized — dangling ` +
        `non-terminal with no PR and all tasks terminal (issue #106)`
    );
  }
}

/**
 * Drop the stored session transcripts of runs that are over (issue #169).
 *
 * A transcript is kept for as long as its run might still resume — while it is
 * `rate_limited` and waiting, and after it resumes too, since a resumed pass
 * may pause again and a restart in between must not strand it. Anything whose
 * run has reached a terminal status, or whose run is gone entirely, is
 * finished with its conversation.
 *
 * At boot rather than on every terminal path: a run reaches a terminal status
 * from a dozen places, and a cleanup hook on each would be one edit away from a
 * leak. One directory sweep costs nothing and cannot miss a path it never knew
 * about — and merging any interlude PR restarts this process, so it runs often.
 *
 * Runs after the recovery above, so a run *this boot* just finalized has its
 * transcript collected in the same pass.
 */
function pruneStoredTranscripts(): void {
  const live = new Set(
    db
      .select({ id: runs.id })
      .from(runs)
      .where(inArray(runs.status, [...ACTIVE_RUN_STATUSES]))
      .all()
      .map((run) => run.id)
  );
  const pruned = pruneTranscripts(live);
  if (pruned > 0) {
    console.log(`[orchestrator] Pruned ${pruned} stored session transcript(s)`);
  }
}

/**
 * Re-adopt the containers of parked, blocked runs (issue #136).
 *
 * `activeTasks` is process memory with one writer (`startTask`), and queue step
 * 2 — the only thing that delivers a queued user message — iterates it and
 * nothing else. Every other layer then deliberately leaves a blocked run alone:
 * recovery skips it (it waits on a human, not a lost turn), and the reaper
 * preserves its container. Each of those is right on its own, and together they
 * meant a restart while a run was `blocked` stranded it forever: the owner's
 * answer landed in `messages` with `deliveredAt` null, no poll could ever see
 * it, and no label, cancel or container action could clear the card.
 *
 * So boot puts the entry back. What it decides is `planParkedAdoption`'s; this
 * gathers the rows, asks the daemon about each container, and executes the
 * plan:
 *
 * - **adopt** — the container is still there, so the entry goes back as parked
 *   and idle. It holds no slot (exactly as it held none before the restart) and
 *   the existing delivery path resumes it on the next 2s poll, on the same
 *   attempt, with the session's own conversation.
 * - **orphaned** — the container is gone, so there is nothing to answer into.
 *   The run must not stay `blocked` forever, so it takes the #24 interruption
 *   path: `interrupted` consumes no attempt and is bounded separately by
 *   `MAX_INTERRUPTIONS_PER_TICKET`, past which pickup routes the ticket
 *   `ready-for-human` like exhaustion. The question and any answer already
 *   given are carried onto the issue, so the owner's words outlive the
 *   container that was going to receive them.
 * - **deferred** — the daemon did not answer. Unknown decides nothing in
 *   either direction (the doctrine of #152/#159): the run stays blocked and the
 *   next boot asks again. Meanwhile the undelivered-answer health signal is
 *   what makes the wait visible rather than silent.
 *
 * Runs before `startQueue`, so an adopted entry is in the map before the first
 * poll, and before the reaper, so an orphaned task's row is already terminal
 * when cleanup looks at it.
 *
 * Exported as the seam it is: "an answer given before the restart is delivered
 * after it" is the whole of this ticket, and it is only observable across this
 * function and the queue's own poll.
 */
export async function adoptParkedContainers(): Promise<void> {
  const parked = await db
    .select({
      taskId: tasks.id,
      runId: tasks.runId,
      status: tasks.status,
      kind: tasks.kind,
      containerName: tasks.containerName,
      containerId: tasks.containerId,
      previewSubdomain: tasks.previewSubdomain,
    })
    .from(tasks)
    .where(eq(tasks.status, "blocked"));

  if (parked.length === 0) return;

  // One probe per container, up front, so the planner stays pure and sync.
  const seen = new Map<string, ContainerPresence>();
  for (const row of parked) {
    if (!row.containerName || seen.has(row.containerName)) continue;
    const absent = await observeContainerAbsent(row.containerName);
    seen.set(
      row.containerName,
      absent === true ? "absent" : absent === false ? "present" : "unknown"
    );
  }

  const plan = planParkedAdoption(
    parked,
    (name) => seen.get(name) ?? "unknown",
    getActiveTasks().keys()
  );

  for (const adoption of plan.adopt) {
    if (!adoptParkedContainer(adoption)) continue;
    console.log(
      `[orchestrator] Re-adopted parked container for blocked task ${adoption.taskId} — ` +
        `a queued answer will be delivered on the next poll`
    );
  }

  for (const taskId of plan.deferred) {
    console.warn(
      `[orchestrator] Blocked task ${taskId}: the daemon could not say whether its ` +
        `container is there — left parked, and re-checked on the next boot`
    );
  }

  for (const orphan of plan.orphaned) {
    await interruptOrphanedParkedTask(orphan);
  }
}

/**
 * A blocked task whose container is gone: end the pass, interrupt the run, and
 * carry the conversation's unfinished business onto the issue (issue #136).
 *
 * The ordering matters in one place only — the issue comment is gathered from
 * the message rows *before* the task is failed, because it is the last chance
 * to read what the owner said to a container that no longer exists. Everything
 * else is the #24 interruption path unchanged: no attempt is consumed, the
 * interruption bound is what limits the retries, and the branch was pushed
 * after each turn so the work itself survives.
 */
async function interruptOrphanedParkedTask(orphan: OrphanedParkedTask): Promise<void> {
  const now = new Date();
  const task = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, orphan.taskId))
    .get();
  const run = orphan.runId
    ? await db.select().from(runs).where(eq(runs.id, orphan.runId)).get()
    : undefined;

  const answers = await db
    .select({ content: messages.content })
    .from(messages)
    .where(
      and(
        eq(messages.taskId, orphan.taskId),
        eq(messages.role, "user"),
        isNull(messages.deliveredAt)
      )
    )
    .orderBy(asc(messages.createdAt));

  await db
    .update(tasks)
    .set({ status: "failed", containerId: null, containerStatus: null, updatedAt: now })
    .where(eq(tasks.id, orphan.taskId));

  await db.insert(messages).values({
    id: newId(),
    taskId: orphan.taskId,
    role: "system",
    content:
      "This pass's container is gone, so the question it was waiting on can no " +
      "longer be answered here. The ticket is re-claimed without consuming an " +
      "attempt, and the question — with anything you had already said — is on the issue.",
    type: "system",
    createdAt: now,
  });

  if (run) {
    await db
      .update(runs)
      .set({
        status: "interrupted",
        interruptionCount: run.interruptionCount + 1,
        finishedAt: now,
      })
      .where(eq(runs.id, run.id));
    console.log(
      `[orchestrator] Blocked run ${run.id} (${run.githubIssue}) lost its container — ` +
        `interrupted, so the sweep re-claims without consuming an attempt`
    );
  }

  if (!task?.githubIssue) return;

  const said = answers
    .map((m) => messageText(m.content))
    .filter((text): text is string => text != null && text.length > 0);

  await commentOnIssue(
    task.githubIssue,
    `A blocked attempt's container was lost before its question could be answered, ` +
      `so the ticket is re-claimed without consuming an attempt. Nothing is lost from ` +
      `the branch \`${task.branch}\` — but the exchange only lived in that container, ` +
      `so it is recorded here for the next attempt.\n\n` +
      `**The agent asked:**\n\n> ${run?.blockedQuestion ?? "(no question recorded)"}\n\n` +
      (said.length > 0
        ? `**Already answered** (never delivered):\n\n${said
            .map((text) => `> ${text.replace(/\n/g, "\n> ")}`)
            .join("\n\n")}`
        : `No answer had been given yet.`)
  ).catch((err) =>
    console.error(`[orchestrator] Failed to carry a lost question onto the issue:`, err)
  );
}

/** A message row's text, however the row was shaped. */
function messageText(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : null;
  } catch {
    return content;
  }
}

async function recoverOrphanedTasks(): Promise<void> {
  const orphaned = await db
    .select({ id: tasks.id, containerName: tasks.containerName, runId: tasks.runId })
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
      content: task.runId
        ? "Orchestrator restarted — this pass's container was lost. Recovery is handled at the run level."
        : "Server restarted — task interrupted. You can re-queue this task.",
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
      filters: { name: [AGENT_CONTAINER_NAME_PREFIX] },
    });

    if (containers.length === 0) return;

    // Get all tasks that should keep their container. Blocked tasks are
    // parked, not dead: their container is deliberately preserved (stopped to
    // free memory since #93, but its filesystem and branch state kept) while
    // the question waits (issue #19), so the reaper must not remove it. Any
    // task owned by a live run is likewise protected whatever its own status
    // (issue #24): recovery must never be fighting cleanup, so while the run is
    // being worked, only the run's own lifecycle may take its containers.
    const activeTasks = await db
      .select({ containerName: tasks.containerName })
      .from(tasks)
      .leftJoin(runs, eq(tasks.runId, runs.id))
      .where(
        or(
          inArray(tasks.status, ["running", "blocked"]),
          inArray(runs.status, [...ACTIVE_RUN_STATUSES])
        )
      );

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

  // Which execution lanes cannot run and why (issue #226) — one line per
  // unavailable lane naming the variables it lacks, nothing when every lane is
  // available. Read off the lane catalog, because the lane file is the one
  // statement of which variables the fleet needs; this replaced a warning that
  // named one vendor's two variables and could say nothing about any other lane.
  reportLaneAvailability();

  const dockerAvailable = await isDockerAvailable();
  if (dockerAvailable) {
    console.log("[orchestrator] Docker available, starting task queue");

    const capacity = await getCapacity();
    console.log(
      `[orchestrator] Capacity: ${capacity.slots} agent slot(s), ` +
        `${Math.round(capacity.perAgentMemory / (1024 * 1024))} MiB + ` +
        `${capacity.cpuQuota / 1e9} CPU per agent`
    );
    if (isGitHubConfigured()) {
      console.log("[orchestrator] GitHub App configured -- webhooks and PR creation enabled");
    } else {
      console.log("[orchestrator] GitHub App not configured -- running without GitHub integration");
    }
    if (isDiscordConfigured()) {
      startDiscordBot()
        .then(() => {
          console.log("[orchestrator] Discord bot started");
          // The daily fleet digest posts through the bot, so it only makes
          // sense once the bot is connected
          startDailyDigest();
        })
        .catch((err) => console.error("[orchestrator] Discord bot failed to start:", err));
    } else {
      console.log("[orchestrator] Discord bot not configured -- running without Discord integration");
    }
    await markInterruptedRuns();
    await finalizeDanglingRuns();
    await recoverOrphanedTasks();
    await adoptParkedContainers();
    await reapStaleContainers();
    pruneStoredTranscripts();
    startQueue();

    // Autonomous pickup: boot sweep + reconciliation interval. The webhook
    // is only latency on top of this — the sweep is the backbone.
    if (getConfig().autonomyEnabled && isGitHubConfigured()) {
      startAutonomySweeps();
      // The runtime kill switch is a DB row, so an engaged one survives the
      // restart. Say so at boot: otherwise a deliberately held fleet reads as a
      // broken one in the logs (sweeps running, nothing ever claimed).
      if (isGlobalAutonomyPaused()) {
        console.log(
          "[autonomy] Global kill switch engaged -- sweeps run, but nothing new is claimed until it is lifted"
        );
      }
    } else {
      console.log(
        "[autonomy] Autonomous pickup disabled" +
          (getConfig().autonomyEnabled ? " (GitHub App not configured)" : " (AUTONOMY_ENABLED != true)")
      );
    }

    // Keep preflight fresh for autonomy-enabled projects independently of
    // autonomy being armed at all, so the dashboard names what's missing while pilots
    // are being set up (and catches drift like branch protection being removed).
    if (isGitHubConfigured()) {
      startPreflightRefresh();
    }

    // Run the reaper every 5 minutes to catch any leaked containers
    setInterval(() => reapStaleContainers().catch(console.error), 5 * 60 * 1000);
  } else {
    console.log(
      "[orchestrator] Docker not available, running in UI-only mode (mock agent still works)"
    );
  }
}
