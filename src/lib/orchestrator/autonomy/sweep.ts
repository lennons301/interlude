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
import { getConfig, PLATFORM_REPO_URL } from "../../config";
import { getOctokit, isGitHubConfigured } from "../../github/client";
import { fetchFileFromDefaultBranch } from "../../github/contents";
import { commentOnIssue, parseIssueRef } from "../../github/issues";
import {
  armAutoMergeSquash,
  getPrState,
  labelPr,
  listChangedFiles,
} from "../../github/pull-requests";
import { parseRepoFromGitUrl } from "../../github/repo";
import {
  notifyGateConfigError,
  notifySlotsSaturated,
} from "../../discord/notifications";
import { getCapacity } from "../capacity";
import { occupiedSlots } from "../queue";
import { getActiveTasks } from "../turn-manager";
import {
  decideNext,
  type Action,
  type AutonomySnapshot,
  type CandidateIssue,
  type PendingGateEvaluation,
} from "./decide";
import {
  ESTATE_GATES_PATH,
  HUMAN_SIGNOFF_LABEL,
  REPO_GATES_PATH,
  parseGateConfig,
  type GateConfig,
} from "./gates";
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
// Run IDs whose gate-config failure the owner has already been told about —
// once per failure, not once per sweep. Pruned as runs leave the pending set.
const announcedGateConfigErrors = new Set<string>();
// Consecutive sweeps each config source has failed to read for reasons that
// looked transient (keyed "owner/repo:path"). A network blip retries
// silently, but a persistent failure — a permissions problem reads the same
// as a timeout from here — must eventually fail closed and tell the owner
// rather than loop quietly forever.
const consecutiveTransientReads = new Map<string, number>();
const TRANSIENT_READ_ESCALATION_SWEEPS = 10;

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
    pendingGateEvaluations: await gatherPendingGateEvaluations(allRuns),
    announcedGateConfigErrors: [...announcedGateConfigErrors],
    // Turn ends are evaluated by the turn manager at the moment they happen,
    // never discovered by a sweep — a sweep snapshot carries no pass outcomes.
    completedPasses: [],
  };
}

/** How one gate-config source read went: usable config, a real config
 * problem to fail closed on, or an API hiccup worth retrying silently. */
type GateConfigRead =
  | { kind: "ok"; config: GateConfig }
  | { kind: "failed"; reason: string }
  | { kind: "transient" };

async function readGateConfigFile(
  owner: string,
  repo: string,
  path: string,
  label: string
): Promise<GateConfigRead> {
  const sourceKey = `${owner}/${repo}:${path}`;
  const file = await fetchFileFromDefaultBranch(owner, repo, path);
  if (!file.ok) {
    if (file.missing) {
      consecutiveTransientReads.delete(sourceKey);
      return {
        kind: "failed",
        reason: `${label} (${path} in ${owner}/${repo}) is missing from the default branch`,
      };
    }
    const failures = (consecutiveTransientReads.get(sourceKey) ?? 0) + 1;
    consecutiveTransientReads.set(sourceKey, failures);
    console.error(
      `[autonomy] Could not read ${path} from ${owner}/${repo} (attempt ${failures}): ${file.reason}`
    );
    if (failures >= TRANSIENT_READ_ESCALATION_SWEEPS) {
      return {
        kind: "failed",
        reason:
          `${label} (${path} in ${owner}/${repo}) could not be read for ` +
          `${failures} consecutive sweeps: ${file.reason}`,
      };
    }
    return { kind: "transient" };
  }
  consecutiveTransientReads.delete(sourceKey);
  const parsed = parseGateConfig(file.text);
  if (!parsed.ok) {
    return {
      kind: "failed",
      reason: `${label} (${path} in ${owner}/${repo}) is unparseable: ${parsed.reason}`,
    };
  }
  return { kind: "ok", config: parsed.config };
}

/**
 * Finished implement passes whose PRs await a gate decision. A run enters
 * this set only once its final push, PR-ready flip and PR-number recording
 * have all happened (completeTask does them in that order), so arming
 * always follows the final push — branch protection dismisses stale
 * approvals, and an early arm would be dismissed with them.
 *
 * Gate config is read from default branches, never the PR's head: a PR
 * cannot widen its own gates. Transient API failures skip the run for this
 * sweep; the reconciliation loop retries. Already-armed, closed and merged
 * PRs have nothing left to decide.
 */
async function gatherPendingGateEvaluations(
  allRuns: Array<typeof runs.$inferSelect>
): Promise<PendingGateEvaluation[]> {
  const awaiting = allRuns.filter(
    (r) => r.status === "implementing" && r.pullRequestNumber != null
  );

  // The owner is re-told about a config failure only if the run left the
  // pending set and somehow returned; otherwise one announcement stands.
  for (const runId of [...announcedGateConfigErrors]) {
    if (!awaiting.some((r) => r.id === runId)) announcedGateConfigErrors.delete(runId);
  }

  if (awaiting.length === 0) return [];

  // The estate config lives in the platform repo; one read serves the sweep.
  const platformRepo = parseRepoFromGitUrl(PLATFORM_REPO_URL);
  const estate: GateConfigRead = platformRepo
    ? await readGateConfigFile(
        platformRepo.owner,
        platformRepo.repo,
        ESTATE_GATES_PATH,
        "estate gate config"
      )
    : { kind: "failed", reason: `platform repo URL is unparseable: ${PLATFORM_REPO_URL}` };
  if (estate.kind === "transient") return [];

  const extensionsByRepo = new Map<string, GateConfigRead>();
  const pending: PendingGateEvaluation[] = [];

  for (const run of awaiting) {
    const ref = parseIssueRef(run.githubIssue);
    if (!ref) {
      console.error(`[autonomy] Run ${run.id} has unparsable issue ref: ${run.githubIssue}`);
      continue;
    }

    const pr = await getPrState(ref.owner, ref.repo, run.pullRequestNumber!);
    if (!pr) continue;
    if (!pr.open || pr.autoMergeArmed) continue;

    const repoKey = `${ref.owner}/${ref.repo}`;
    let extension = extensionsByRepo.get(repoKey);
    if (!extension) {
      extension = await readGateConfigFile(
        ref.owner,
        ref.repo,
        REPO_GATES_PATH,
        "repo gate extension"
      );
      extensionsByRepo.set(repoKey, extension);
    }
    if (extension.kind === "transient") continue;

    let gateConfig: PendingGateEvaluation["gateConfig"];
    let changedPaths: string[] = [];
    if (estate.kind === "failed") {
      gateConfig = { ok: false, reason: estate.reason };
    } else if (extension.kind === "failed") {
      gateConfig = { ok: false, reason: extension.reason };
    } else {
      const files = await listChangedFiles(ref.owner, ref.repo, run.pullRequestNumber!);
      if (files === null) continue;
      changedPaths = files;
      gateConfig = { ok: true, estate: estate.config, extension: extension.config };
    }

    pending.push({
      runId: run.id,
      issueRef: run.githubIssue,
      prNumber: run.pullRequestNumber!,
      changedPaths,
      gateConfig,
    });
  }

  return pending;
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
      case "gatePr":
        await executeGatePr(action);
        break;
      case "armAutoMerge":
        await executeArmAutoMerge(action);
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
        } else if (action.event === "gate-config-error") {
          await executeGateConfigError(action.payload);
        }
        break;
    }
  }
}

/**
 * A gated PR: label it human-signoff, leave auto-merge disarmed, record the
 * matched categories on the run, and say so on the issue. The label goes on
 * first — if it fails, the run stays pending and the next sweep retries.
 */
async function executeGatePr(action: Extract<Action, { type: "gatePr" }>): Promise<void> {
  const ref = parseIssueRef(action.issueRef);
  if (!ref) return;

  const labeled = await labelPr(ref.owner, ref.repo, action.prNumber, HUMAN_SIGNOFF_LABEL);
  if (!labeled) return;

  db.update(runs)
    .set({ status: "gated", gateCategories: action.categories })
    .where(eq(runs.id, action.runId))
    .run();

  console.log(
    `[autonomy] Gated ${action.issueRef} PR #${action.prNumber}: ${action.categories.join(", ")}`
  );
  await commentOnIssue(
    action.issueRef,
    `Review gates: PR #${action.prNumber} touches **${action.categories.join(", ")}** — ` +
      `labelled \`${HUMAN_SIGNOFF_LABEL}\`, auto-merge left disarmed. A human approves and merges this one.`
  );
}

/**
 * An ungated PR: arm auto-merge (squash) and say so on the issue. Arming
 * failure (e.g. auto-merge disabled on the repo) leaves the run pending for
 * the next sweep and is already logged by the GitHub helper.
 */
async function executeArmAutoMerge(
  action: Extract<Action, { type: "armAutoMerge" }>
): Promise<void> {
  const ref = parseIssueRef(action.issueRef);
  if (!ref) return;

  const armed = await armAutoMergeSquash(ref.owner, ref.repo, action.prNumber);
  if (!armed) return;

  console.log(`[autonomy] Armed auto-merge on ${action.issueRef} PR #${action.prNumber}`);
  await commentOnIssue(
    action.issueRef,
    `Review gates: PR #${action.prNumber} matched no gates — auto-merge (squash) armed; ` +
      `an approving review will land it.`
  );
}

/**
 * Gate config missing or unparseable: nothing is armed, and the owner is
 * told — on the issue, in the fleet channel, and in the log — once per
 * failure. The run stays pending, so fixing the config on the default
 * branch lets the next sweep decide it with no further ceremony.
 */
async function executeGateConfigError(payload: {
  runId: string;
  issueRef: string;
  prNumber: number;
  reason: string;
}): Promise<void> {
  announcedGateConfigErrors.add(payload.runId);
  console.error(
    `[autonomy] Gate evaluation failed closed for ${payload.issueRef} PR #${payload.prNumber}: ${payload.reason}`
  );
  await commentOnIssue(
    payload.issueRef,
    `Review gates could not be evaluated: ${payload.reason}. ` +
      `Failing closed — PR #${payload.prNumber} stays disarmed until the config on the default branch is fixed.`
  );
  await notifyGateConfigError(getConfig().discordFleetChannelId, payload);
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
