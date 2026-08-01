/**
 * The I/O shell around the pure reducer (issue #15): gather a snapshot of
 * the world, ask decideNext what to do, execute the actions. The
 * `issues.labeled` webhook and the reconciliation sweep (boot + interval)
 * both land here, so there is exactly one decision path.
 */

import { db } from "@/db";
import { projects, runs, tasks } from "@/db/schema";
import { eq, isNotNull } from "drizzle-orm";
import { newId } from "../../ulid";
import { getConfig } from "../../config";
import { getOctokit, isGitHubConfigured } from "../../github/client";
import { commentOnIssue, parseIssueRef } from "../../github/issues";
import { notifySlotsSaturated } from "../../discord/notifications";
import { getCapacity } from "../capacity";
import { occupiedSlots } from "../queue";
import { getActiveTasks } from "../turn-manager";
import {
  decideNext,
  type Action,
  type AutonomySnapshot,
  type CandidateIssue,
} from "./decide";
import { ARMING_LABEL, labelNames, parseBlockedByRefs } from "./ticket";
import { buildImplementPrompt } from "./workflow";

/** Default per-attempt budget for autonomous runs. Issue #18 adds ticket
 * directives and clamping on top of this. */
export const DEFAULT_ATTEMPT_BUDGET_USD = 20;
/** Attempts per ticket before the reducer refuses further claims. */
export const MAX_ATTEMPTS = 3;

const SWEEP_INTERVAL_MS = 30_000;

/** Run statuses that mean "this issue is being worked" — not re-claimable. */
const ACTIVE_RUN_STATUSES = new Set([
  "claimed",
  "implementing",
  "reviewing",
  "gated",
  "blocked",
]);

let sweepInterval: ReturnType<typeof setInterval> | null = null;
let sweeping = false;
let saturationAnnounced = false;
const inFlightClaims = new Set<string>();

export function startAutonomySweeps(): void {
  if (sweepInterval) return;
  console.log(`[autonomy] Reconciliation sweep every ${SWEEP_INTERVAL_MS / 1000}s`);
  runAutonomySweep().catch((err) => console.error("[autonomy] Boot sweep failed:", err));
  sweepInterval = setInterval(
    () => runAutonomySweep().catch((err) => console.error("[autonomy] Sweep failed:", err)),
    SWEEP_INTERVAL_MS
  );
}

export function stopAutonomySweeps(): void {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
}

/**
 * One pass of gather → decide → execute. Single-flight: a webhook trigger
 * arriving mid-sweep is a no-op, the running sweep already sees the world.
 */
export async function runAutonomySweep(): Promise<void> {
  const config = getConfig();
  if (!config.autonomyEnabled) return; // global kill switch
  if (!isGitHubConfigured()) return;
  if (sweeping) return;
  sweeping = true;

  try {
    const snapshot = await gatherSnapshot(new Date());
    const actions = decideNext(snapshot);
    await executeActions(actions);

    // Saturation announcement is once per transition: mark announced when the
    // reducer said so, clear the flag once a slot frees up again.
    if (snapshot.slots.occupied < snapshot.slots.total) {
      saturationAnnounced = false;
    } else if (actions.some((a) => a.type === "notify" && a.event === "slots-saturated")) {
      saturationAnnounced = true;
    }
  } finally {
    sweeping = false;
  }
}

async function gatherSnapshot(now: Date): Promise<AutonomySnapshot> {
  const config = getConfig();
  const capacity = await getCapacity();

  const registered = db
    .select()
    .from(projects)
    .where(isNotNull(projects.githubRepo))
    .all();

  const queuedTasks = db
    .select({ kind: tasks.kind })
    .from(tasks)
    .where(eq(tasks.status, "queued"))
    .all();

  const allRuns = db.select().from(runs).all();

  // Occupant labels for the saturation announcement
  const occupants: string[] = [];
  for (const [taskId] of getActiveTasks()) {
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (task) occupants.push(`${task.kind}: ${task.githubIssue ?? task.title}`);
  }

  const candidates: CandidateIssue[] = [];
  const octokit = await getOctokit();

  for (const project of registered) {
    const repoFullName = project.githubRepo!;
    const [owner, repo] = repoFullName.split("/");
    if (!owner || !repo) continue;

    try {
      const { data: issues } = await octokit.rest.issues.listForRepo({
        owner,
        repo,
        labels: ARMING_LABEL,
        state: "open",
        per_page: 100,
      });

      for (const issue of issues) {
        if (issue.pull_request) continue; // PRs are issues to the API, not to us

        const issueRef = `${repoFullName}#${issue.number}`;
        const body = issue.body ?? "";
        const issueRuns = allRuns.filter((r) => r.githubIssue === issueRef);

        candidates.push({
          issueRef,
          repo: repoFullName,
          number: issue.number,
          title: issue.title,
          body,
          author: issue.user?.login ?? "",
          labels: labelNames(issue.labels),
          armedAt: await resolveArmedAt(octokit, owner, repo, issue.number, new Date(issue.created_at)),
          hasOpenBlocker: await hasOpenBlocker(octokit, owner, repo, issue, body),
          attemptsMade: issueRuns.filter((r) => r.status === "failed").length,
          hasActiveRun: issueRuns.some((r) => ACTIVE_RUN_STATUSES.has(r.status)),
        });
      }
    } catch (err) {
      // One repo's API failure must not stall the whole fleet's sweep
      console.error(`[autonomy] Failed to list candidates for ${repoFullName}:`, err);
    }
  }

  return {
    now,
    autonomyEnabledGlobal: config.autonomyEnabled,
    attemptBudgetUsd: DEFAULT_ATTEMPT_BUDGET_USD,
    maxAttempts: MAX_ATTEMPTS,
    allowedAuthors: config.autonomyAllowedAuthors,
    slots: { total: capacity.slots, occupied: occupiedSlots(), occupants },
    queuedInteractiveCount: queuedTasks.filter((t) => t.kind === "interactive").length,
    queuedImplementCount: queuedTasks.filter((t) => t.kind === "implement").length,
    saturationAnnounced,
    projects: registered.map((p) => ({
      id: p.id,
      repo: p.githubRepo!,
      autonomyEnabled: p.autonomyEnabled,
      preflightStatus: p.preflightStatus,
      preflightReason: p.preflightReason,
    })),
    candidates,
    inFlightClaims: [...inFlightClaims],
  };
}

/** When ready-for-agent was applied — the "armed at" ordering key. Paginates
 * the full event history: an event-heavy issue whose labeled event fell off
 * the first page must not queue-jump on its (earlier) creation time. Falls
 * back to creation time only when the event genuinely can't be read. */
async function resolveArmedAt(
  octokit: Awaited<ReturnType<typeof getOctokit>>,
  owner: string,
  repo: string,
  issueNumber: number,
  createdAt: Date
): Promise<Date> {
  try {
    const events = await octokit.paginate(octokit.rest.issues.listEvents, {
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    });
    const labeled = events.filter(
      (e) =>
        e.event === "labeled" &&
        (e as { label?: { name?: string } }).label?.name === ARMING_LABEL
    );
    const last = labeled[labeled.length - 1];
    return last ? new Date(last.created_at) : createdAt;
  } catch {
    return createdAt;
  }
}

/** Open blocker: a native GitHub issue dependency, or a `Blocked by: #n`
 * line naming a still-open issue in the same repo. */
async function hasOpenBlocker(
  octokit: Awaited<ReturnType<typeof getOctokit>>,
  owner: string,
  repo: string,
  issue: { number: number },
  body: string
): Promise<boolean> {
  const summary = (
    issue as { issue_dependencies_summary?: { blocked_by?: number } }
  ).issue_dependencies_summary;
  if ((summary?.blocked_by ?? 0) > 0) return true;

  for (const blockerNumber of parseBlockedByRefs(body)) {
    try {
      const { data: blocker } = await octokit.rest.issues.get({
        owner,
        repo,
        issue_number: blockerNumber,
      });
      if (blocker.state === "open") return true;
    } catch {
      // A dangling ref (deleted/transferred issue) fails closed
      return true;
    }
  }
  return false;
}

async function executeActions(actions: Action[]): Promise<void> {
  for (const action of actions) {
    switch (action.type) {
      case "claimIssue":
        await executeClaim(action);
        break;
      case "pausePickup":
        console.log(
          `[autonomy] Pickup paused (${action.reason})${action.detail ? `: ${action.detail}` : ""}`
        );
        break;
      case "notify":
        if (action.event === "slots-saturated") {
          console.log(
            `[autonomy] All ${action.payload.total} slot(s) busy: ${action.payload.occupants.join(", ")}`
          );
          await notifySlotsSaturated(getConfig().discordFleetChannelId, action.payload);
        }
        break;
    }
  }
}

/**
 * Open a run and queue its implement task. The prompt is built here — at
 * claim time — so an unresolvable workflow selection fails the run loudly
 * before a container ever starts, and the failed run bounds re-claims.
 */
async function executeClaim(action: Extract<Action, { type: "claimIssue" }>): Promise<void> {
  if (inFlightClaims.has(action.issueRef)) return;
  inFlightClaims.add(action.issueRef);

  try {
    const now = new Date();
    const runId = newId();

    const parsedRef = parseIssueRef(action.issueRef);
    if (!parsedRef) {
      console.error(`[autonomy] Unparsable issue ref, refusing claim: ${action.issueRef}`);
      return;
    }

    let prompt: string | null = null;
    let failure: string | null = null;
    try {
      prompt = buildImplementPrompt({
        repo: `${parsedRef.owner}/${parsedRef.repo}`,
        issueNumber: action.issueNumber,
        issueTitle: action.issueTitle,
        issueBody: action.issueBody,
        workflow: action.workflow,
      });
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }

    db.insert(runs)
      .values({
        id: runId,
        projectId: action.projectId,
        githubIssue: action.issueRef,
        attempt: action.attempt,
        mode: action.mode,
        status: failure ? "failed" : "claimed",
        budgetUsd: action.budgetUsd,
        claimedAt: now,
        finishedAt: failure ? now : null,
      })
      .run();

    if (failure) {
      console.error(`[autonomy] Claim of ${action.issueRef} failed before start: ${failure}`);
      await commentOnIssue(
        action.issueRef,
        `Run failed before start (attempt ${action.attempt}/${MAX_ATTEMPTS}): ${failure}`
      );
      return;
    }

    const taskId = newId();
    db.insert(tasks)
      .values({
        id: taskId,
        projectId: action.projectId,
        title: action.issueTitle,
        description: prompt!,
        status: "queued",
        kind: "implement",
        runId,
        githubIssue: action.issueRef,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    console.log(
      `[autonomy] Claimed ${action.issueRef} (attempt ${action.attempt}) -> task ${taskId}`
    );
    const domain = process.env.DOMAIN ?? "interludes.co.uk";
    await commentOnIssue(
      action.issueRef,
      `Claimed by Interlude — attempt ${action.attempt}/${MAX_ATTEMPTS}.\n\n` +
        `[View task](https://${domain}/tasks/${taskId})`
    );
  } finally {
    inFlightClaims.delete(action.issueRef);
  }
}
