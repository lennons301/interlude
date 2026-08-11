import { db } from "@/db";
import { tasks, messages, runs } from "@/db/schema";
import { and, eq, inArray, or } from "drizzle-orm";
import { newId } from "../ulid";
import { getDocker, isDockerAvailable } from "../docker/client";
import { startQueue } from "./queue";
import { getCapacity } from "./capacity";
import { ACTIVE_RUN_STATUSES, startAutonomySweeps } from "./autonomy/sweep";
import { startPreflightRefresh } from "./autonomy/preflight";
import { startDailyDigest } from "./digest-schedule";
import { getConfig } from "../config";
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
 * run — and `gated`/`blocked` runs are waiting on a human, not on a lost
 * turn, so re-running their implement pass would buy nothing.
 *
 * Must run before recoverOrphanedTasks, which rewrites the `running` task
 * statuses this reads.
 */
async function markInterruptedRuns(): Promise<void> {
  const activeRuns = await db
    .select()
    .from(runs)
    .where(inArray(runs.status, ["claimed", "implementing", "reviewing"]));

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
    .where(inArray(runs.status, ["claimed", "implementing", "reviewing"]));

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
      filters: { name: ["interlude-task-"] },
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
    await reapStaleContainers();
    startQueue();

    // Autonomous pickup: boot sweep + reconciliation interval. The webhook
    // is only latency on top of this — the sweep is the backbone.
    if (getConfig().autonomyEnabled && isGitHubConfigured()) {
      startAutonomySweeps();
    } else {
      console.log(
        "[autonomy] Autonomous pickup disabled" +
          (getConfig().autonomyEnabled ? " (GitHub App not configured)" : " (AUTONOMY_ENABLED != true)")
      );
    }

    // Keep preflight fresh for autonomy-enabled projects independently of the
    // global kill switch, so the dashboard names what's missing while pilots
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
