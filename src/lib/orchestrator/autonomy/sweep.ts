/**
 * The I/O shell around the pure reducer (issue #15): gather a snapshot of
 * the world, ask decideNext what to do, execute the actions. The
 * `issues.labeled` webhook and the reconciliation sweep (boot + interval)
 * both land here, so there is exactly one decision path.
 */

import { db } from "@/db";
import { messages, projects, runs, tasks } from "@/db/schema";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { newId } from "../../ulid";
import { getConfig, PLATFORM_REPO_URL } from "../../config";
import { getOctokit, isGitHubConfigured } from "../../github/client";
import { fetchFileFromDefaultBranch } from "../../github/contents";
import { commentOnIssue, parseIssueRef } from "../../github/issues";
import {
  armAutoMergeSquash,
  disarmAutoMerge,
  getPrState,
  labelPr,
  listChangedFiles,
  postReviewAsReviewer,
} from "../../github/pull-requests";
import { parseRepoFromGitUrl } from "../../github/repo";
import {
  notifyGateConfigError,
  notifyReviewBlocked,
  notifySlotsSaturated,
} from "../../discord/notifications";
import { recordBacklog } from "../../fleet/backlog";
import { getCapacity } from "../capacity";
import { occupiedSlots } from "../queue";
import { getActiveTasks, isParked, releaseParkedImplementTask } from "../turn-manager";
import {
  decideNext,
  type Action,
  type AutonomySnapshot,
  type AwaitingReview,
  type CandidateIssue,
  type PendingGateEvaluation,
  type PendingVerdict,
  type SettledPr,
} from "./decide";
import {
  ESTATE_GATES_PATH,
  HUMAN_SIGNOFF_LABEL,
  REPO_GATES_PATH,
  parseGateConfig,
  type GateConfig,
} from "./gates";
import { ARMING_LABEL, labelNames, parseBlockedByRefs } from "./ticket";
import { buildImplementPrompt, buildReviewPrompt } from "./workflow";
import { DEFAULT_ATTEMPT_BUDGET_USD } from "./budgets";

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
// Same pattern for review failures: unparseable verdicts (fed back into the
// snapshot so the reducer stays one-shot) and reviews the orchestrator could
// not post (executor-level, e.g. REVIEWER_GH_TOKEN missing).
const announcedVerdictErrors = new Set<string>();
const announcedReviewPostFailures = new Set<string>();
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

  // Occupant labels for the saturation announcement. Parked containers
  // (implement passes idling while their PR is reviewed) hold no slot.
  const occupants: string[] = [];
  for (const [taskId, entry] of getActiveTasks()) {
    if (isParked(entry)) continue;
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

      let unclaimed = 0;
      for (const issue of issues) {
        if (issue.pull_request) continue; // PRs are issues to the API, not to us

        const issueRef = `${repoFullName}#${issue.number}`;
        const body = issue.body ?? "";
        const issueRuns = allRuns.filter((r) => r.githubIssue === issueRef);
        const hasActiveRun = issueRuns.some((r) => ACTIVE_RUN_STATUSES.has(r.status));
        if (!hasActiveRun) unclaimed++;

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
          hasActiveRun,
        });
      }
      // Feed the read model's backlog depth (dashboard + daily digest) from
      // this listing — recorded only on success, so a failed repo keeps its
      // last good observation rather than reading as an empty queue.
      recordBacklog(project.id, unclaimed);
    } catch (err) {
      // One repo's API failure must not stall the whole fleet's sweep
      console.error(`[autonomy] Failed to list candidates for ${repoFullName}:`, err);
    }
  }

  const reviewState = await gatherReviewState(allRuns);

  return {
    now,
    autonomyEnabledGlobal: config.autonomyEnabled,
    attemptBudgetUsd: DEFAULT_ATTEMPT_BUDGET_USD,
    maxAttempts: MAX_ATTEMPTS,
    allowedAuthors: config.autonomyAllowedAuthors,
    slots: { total: capacity.slots, occupied: occupiedSlots(), occupants },
    queuedInteractiveCount: queuedTasks.filter((t) => t.kind === "interactive").length,
    queuedImplementCount: queuedTasks.filter((t) => t.kind === "implement").length,
    queuedReviewCount: queuedTasks.filter((t) => t.kind === "review").length,
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
    awaitingReview: reviewState.awaitingReview,
    pendingVerdicts: reviewState.pendingVerdicts,
    settledPrs: reviewState.settledPrs,
    announcedVerdictErrors: [...announcedVerdictErrors],
  };
}

/**
 * The review half of the snapshot: runs whose gate decision is made
 * (`reviewing` = armed, `gated` = human-signoff) progress through
 * review-task → stored verdict → posted verdict → settled PR. Each fact the
 * reducer needs is gathered here; a GitHub read failure skips that run for
 * this sweep and the reconciliation loop retries.
 */
async function gatherReviewState(allRuns: Array<typeof runs.$inferSelect>): Promise<{
  awaitingReview: AwaitingReview[];
  pendingVerdicts: PendingVerdict[];
  settledPrs: SettledPr[];
}> {
  const awaitingReview: AwaitingReview[] = [];
  const pendingVerdicts: PendingVerdict[] = [];
  const settledPrs: SettledPr[] = [];

  const reviewable = allRuns.filter(
    (r) =>
      (r.status === "reviewing" || r.status === "gated") && r.pullRequestNumber != null
  );

  // The owner is re-told about a verdict failure only if the run left the
  // review pipeline and somehow returned; otherwise one announcement stands.
  for (const runId of [...announcedVerdictErrors]) {
    if (!reviewable.some((r) => r.id === runId)) announcedVerdictErrors.delete(runId);
  }
  for (const runId of [...announcedReviewPostFailures]) {
    if (!reviewable.some((r) => r.id === runId)) announcedReviewPostFailures.delete(runId);
  }

  for (const run of reviewable) {
    const ref = parseIssueRef(run.githubIssue);
    if (!ref) continue;

    const pr = await getPrState(ref.owner, ref.repo, run.pullRequestNumber!);
    if (!pr) continue;

    if (!pr.open) {
      settledPrs.push({
        runId: run.id,
        issueRef: run.githubIssue,
        prNumber: run.pullRequestNumber!,
        merged: pr.merged,
      });
      continue;
    }

    const armed = run.status === "reviewing";

    if (run.reviewResult != null) {
      pendingVerdicts.push({
        runId: run.id,
        issueRef: run.githubIssue,
        prNumber: run.pullRequestNumber!,
        armed,
        result: run.reviewResult,
        implementTaskId: liveImplementTaskId(run.id),
      });
      continue;
    }

    // A posted verdict with no new result means the run waits on GitHub (an
    // armed approval auto-merging) or on a human (a gated PR) — nothing to do.
    if (run.reviewVerdict != null) continue;

    const reviewTask = db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.runId, run.id),
          eq(tasks.kind, "review"),
          inArray(tasks.status, ["queued", "running"])
        )
      )
      .get();

    awaitingReview.push({
      runId: run.id,
      issueRef: run.githubIssue,
      prNumber: run.pullRequestNumber!,
      armed,
      hasReviewTask: reviewTask != null,
    });
  }

  return { awaitingReview, pendingVerdicts, settledPrs };
}

/** The implement task a run owns (a run has at most one implement pass). */
function implementTaskOf(runId: string) {
  return db
    .select({ id: tasks.id, status: tasks.status, containerStatus: tasks.containerStatus })
    .from(tasks)
    .where(and(eq(tasks.runId, runId), eq(tasks.kind, "implement")))
    .get();
}

/**
 * Whether a run's implement pass has finished its current turn and settled:
 * parked idle (the normal case), or its task already completed/failed (a
 * degraded pass — gate evaluation still proceeds so review can escalate).
 * A running turn, or a fix-up message waiting to be delivered, means the
 * diff is still moving — evaluating gates now would arm a stale decision.
 */
function implementPassSettled(runId: string): boolean {
  const implementTask = implementTaskOf(runId);
  if (!implementTask) return false;

  const settled =
    implementTask.status === "running"
      ? implementTask.containerStatus === "idle"
      : implementTask.status === "completed" || implementTask.status === "failed";
  if (!settled) return false;

  const undelivered = db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.taskId, implementTask.id),
        eq(messages.role, "user"),
        isNull(messages.deliveredAt)
      )
    )
    .get();
  return undelivered == null;
}

/** The run's implement task, if its container is still alive to take a
 * fix-up turn. */
function liveImplementTaskId(runId: string): string | null {
  const implementTask = implementTaskOf(runId);
  if (!implementTask || implementTask.status !== "running") return null;
  return getActiveTasks().has(implementTask.id) ? implementTask.id : null;
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
 * this set only once its pass has finished a turn and parked — the final
 * push, PR-ready flip and PR-number recording have all happened — so arming
 * always follows the final push: branch protection dismisses stale
 * approvals, and an early arm would be dismissed with them. A pass whose
 * container is gone but whose task completed (budget stop, pre-#17 runs)
 * still gates; its review just can't hand feedback back. A run with an
 * undelivered fix-up message is mid-cycle, not awaiting gates.
 *
 * Gate config is read from default branches, never the PR's head: a PR
 * cannot widen its own gates. Transient API failures skip the run for this
 * sweep; the reconciliation loop retries. Closed PRs have nothing left to
 * decide.
 */
async function gatherPendingGateEvaluations(
  allRuns: Array<typeof runs.$inferSelect>
): Promise<PendingGateEvaluation[]> {
  const awaiting = allRuns.filter(
    (r) =>
      r.status === "implementing" &&
      r.pullRequestNumber != null &&
      implementPassSettled(r.id)
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
    if (!pr.open) continue;

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
  // Runs whose postVerdict failed this pass — their deliverFeedback must not
  // run, or a re-posted verdict next sweep would deliver the fix-up twice.
  const failedVerdictPosts = new Set<string>();

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
      case "startReview":
        await executeStartReview(action);
        break;
      case "postVerdict": {
        const posted = await executePostVerdict(action);
        if (!posted) failedVerdictPosts.add(action.runId);
        break;
      }
      case "deliverFeedback":
        if (!failedVerdictPosts.has(action.runId)) {
          await executeDeliverFeedback(action);
        }
        break;
      case "finalizeRun":
        await executeFinalizeRun(action);
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
        } else if (action.event === "verdict-unparseable") {
          await executeVerdictUnparseable(action.payload);
        }
        break;
    }
  }
}

/**
 * A gated PR: label it human-signoff, leave auto-merge disarmed, record the
 * matched categories on the run, and say so on the issue. The label goes on
 * first — if it fails, the run stays pending and the next sweep retries.
 * Moving to `gated` clears any previous cycle's verdict: the review pass
 * that follows judges the PR as it now stands.
 */
async function executeGatePr(action: Extract<Action, { type: "gatePr" }>): Promise<void> {
  const ref = parseIssueRef(action.issueRef);
  if (!ref) return;

  const labeled = await labelPr(ref.owner, ref.repo, action.prNumber, HUMAN_SIGNOFF_LABEL);
  if (!labeled) return;

  db.update(runs)
    .set({
      status: "gated",
      gateCategories: action.categories,
      reviewVerdict: null,
      reviewResult: null,
    })
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
 * An ungated PR: arm auto-merge (squash), move the run to `reviewing`, and
 * say so on the issue. The status flip is what hands the run to the review
 * machinery, and it clears any previous cycle's verdict. Arming an
 * already-armed PR (a crash between arm and flip, or a re-gate after a
 * fix-up cycle) is tolerated by re-reading the PR's state. Genuine arming
 * failure (e.g. auto-merge disabled on the repo) leaves the run pending for
 * the next sweep and is already logged by the GitHub helper.
 */
async function executeArmAutoMerge(
  action: Extract<Action, { type: "armAutoMerge" }>
): Promise<void> {
  const ref = parseIssueRef(action.issueRef);
  if (!ref) return;

  let armed = await armAutoMergeSquash(ref.owner, ref.repo, action.prNumber);
  if (!armed) {
    const pr = await getPrState(ref.owner, ref.repo, action.prNumber);
    armed = pr?.autoMergeArmed === true;
  }
  if (!armed) return;

  db.update(runs)
    .set({
      status: "reviewing",
      gateCategories: [],
      reviewVerdict: null,
      reviewResult: null,
    })
    .where(eq(runs.id, action.runId))
    .run();

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
 * Queue a review pass: a separately queued unit of work drawing a slot like
 * any other pass, in its own container with a fresh clone of the PR branch
 * and fresh context. The prompt is built here from the vendored reviewer
 * definition and the live issue — never from anything a container wrote.
 * The pass receives no credential beyond the ordinary short-lived App token
 * the container setup uses for cloning.
 */
async function executeStartReview(
  action: Extract<Action, { type: "startReview" }>
): Promise<void> {
  const ref = parseIssueRef(action.issueRef);
  if (!ref) return;

  const run = db.select().from(runs).where(eq(runs.id, action.runId)).get();
  if (!run) return;

  try {
    const octokit = await getOctokit();
    const { data: issue } = await octokit.rest.issues.get({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.number,
    });

    const implementTask = db
      .select({ branch: tasks.branch })
      .from(tasks)
      .where(and(eq(tasks.runId, run.id), eq(tasks.kind, "implement")))
      .get();
    const branch = implementTask?.branch ?? `agent/issue-${ref.number}`;

    const prompt = buildReviewPrompt({
      repo: `${ref.owner}/${ref.repo}`,
      issueNumber: ref.number,
      issueTitle: issue.title,
      issueBody: issue.body ?? "",
      prNumber: action.prNumber,
      armed: action.armed,
    });

    const now = new Date();
    const taskId = newId();
    db.insert(tasks)
      .values({
        id: taskId,
        projectId: run.projectId,
        title: `Review PR #${action.prNumber}: ${issue.title}`,
        description: prompt,
        status: "queued",
        kind: "review",
        runId: run.id,
        githubIssue: action.issueRef,
        branch,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    console.log(
      `[autonomy] Queued review of ${action.issueRef} PR #${action.prNumber} -> task ${taskId}`
    );
  } catch (err) {
    // Missing reviewer definition or a GitHub read failure: the run stays
    // awaiting review and the next sweep retries.
    console.error(`[autonomy] Failed to queue review for ${action.issueRef}:`, err);
  }
}

/**
 * Post a parsed verdict through the reviewer identity — the one credential
 * boundary of the loop. Ordering fails safe: anything that reduces automation
 * (disarm, human-signoff label) happens before the review is posted, and the
 * run's ledger advances only after posting succeeds. Returns false when the
 * post did not happen, so the caller suppresses the paired fix-up delivery.
 */
async function executePostVerdict(
  action: Extract<Action, { type: "postVerdict" }>
): Promise<boolean> {
  const ref = parseIssueRef(action.issueRef);
  if (!ref) return false;

  if (action.verdict !== "approve" && action.armed) {
    const disarmed = await disarmAutoMerge(ref.owner, ref.repo, action.prNumber);
    if (!disarmed) return false;
  }
  if (action.verdict === "escalate") {
    const labeled = await labelPr(ref.owner, ref.repo, action.prNumber, HUMAN_SIGNOFF_LABEL);
    if (!labeled) return false;
  }

  const reviewEvent =
    action.verdict === "approve"
      ? "APPROVE"
      : action.verdict === "request-changes"
        ? "REQUEST_CHANGES"
        : "COMMENT";
  const body =
    action.body ||
    "Approved — the change does what the ticket asks. (Review posted by the Interlude orchestrator from the review pass's verdict.)";

  const posted = await postReviewAsReviewer(
    ref.owner,
    ref.repo,
    action.prNumber,
    reviewEvent,
    body
  );
  if (!posted) {
    if (!announcedReviewPostFailures.has(action.runId)) {
      announcedReviewPostFailures.add(action.runId);
      await commentOnIssue(
        action.issueRef,
        `The review pass returned **${action.verdict}**, but the review could not be ` +
          `posted (REVIEWER_GH_TOKEN missing or rejected). Nothing merges until this is fixed.`
      );
      await notifyReviewBlocked(getConfig().discordFleetChannelId, {
        issueRef: action.issueRef,
        prNumber: action.prNumber,
        reason: `the ${action.verdict} review could not be posted — REVIEWER_GH_TOKEN missing or rejected`,
      });
    }
    return false;
  }
  announcedReviewPostFailures.delete(action.runId);

  if (action.verdict === "approve") {
    db.update(runs)
      .set({ reviewVerdict: "approve", reviewResult: null })
      .where(eq(runs.id, action.runId))
      .run();
    await releaseImplementContainer(action.runId, "Review approved — releasing container.");
    await commentOnIssue(
      action.issueRef,
      action.armed
        ? `Review verdict: **approve** — auto-merge will land PR #${action.prNumber}.`
        : `Review verdict: **approve** — PR #${action.prNumber} awaits your sign-off.`
    );
  } else if (action.verdict === "request-changes") {
    const run = db.select().from(runs).where(eq(runs.id, action.runId)).get();
    db.update(runs)
      .set({
        reviewVerdict: "request-changes",
        reviewResult: null,
        status: "implementing",
        reviewCycleCount: (run?.reviewCycleCount ?? 0) + 1,
      })
      .where(eq(runs.id, action.runId))
      .run();
    await commentOnIssue(
      action.issueRef,
      `Review verdict: **request-changes** on PR #${action.prNumber} — feedback ` +
        `delivered to the implement agent as a follow-up turn (same attempt).`
    );
  } else {
    db.update(runs)
      .set({ reviewVerdict: "escalate", reviewResult: null, status: "gated" })
      .where(eq(runs.id, action.runId))
      .run();
    await releaseImplementContainer(action.runId, "Review escalated to a human — releasing container.");
    await commentOnIssue(
      action.issueRef,
      `Review verdict: **escalate** — PR #${action.prNumber} labelled ` +
        `\`${HUMAN_SIGNOFF_LABEL}\`, auto-merge disarmed. The reviewer's assessment is on the PR.`
    );
  }

  console.log(
    `[autonomy] Posted ${action.verdict} review on ${action.issueRef} PR #${action.prNumber}`
  );
  return true;
}

/**
 * Hand the reviewer's findings to the still-live implement container as an
 * ordinary queued user message — the existing message queue delivers it as
 * the next turn, inside the same attempt. Guarded by the run's state so a
 * replayed action cannot double-deliver.
 */
async function executeDeliverFeedback(
  action: Extract<Action, { type: "deliverFeedback" }>
): Promise<void> {
  const run = db.select().from(runs).where(eq(runs.id, action.runId)).get();
  if (!run || run.status !== "implementing" || run.reviewVerdict !== "request-changes") {
    return;
  }

  db.insert(messages)
    .values({
      id: newId(),
      taskId: action.taskId,
      role: "user",
      type: "text",
      content: JSON.stringify({ text: action.body }),
      createdAt: new Date(),
    })
    .run();

  console.log(`[autonomy] Delivered review feedback to task ${action.taskId} (${action.issueRef})`);
}

/**
 * A reviewed PR closed on GitHub: settle the ledger row — merged work is
 * the loop's success case, a human closing unmerged is a deliberate act
 * (like cancelling a task, it consumes no attempt) — and release whatever
 * container was still parked.
 */
async function executeFinalizeRun(
  action: Extract<Action, { type: "finalizeRun" }>
): Promise<void> {
  db.update(runs)
    .set({
      status: action.outcome === "merged" ? "merged" : "cancelled",
      finishedAt: new Date(),
    })
    .where(eq(runs.id, action.runId))
    .run();

  await releaseImplementContainer(
    action.runId,
    action.outcome === "merged"
      ? `PR #${action.prNumber} merged — releasing container.`
      : `PR #${action.prNumber} closed without merging — releasing container.`
  );

  console.log(`[autonomy] Run ${action.runId} settled: ${action.issueRef} ${action.outcome}`);
}

/**
 * An unparseable verdict fails closed: disarm, add human oversight, tell the
 * owner (once), and leave the stored result in place as the record. No
 * review is posted and nothing can merge until a human looks.
 */
async function executeVerdictUnparseable(payload: {
  runId: string;
  issueRef: string;
  prNumber: number;
  reason: string;
  armed: boolean;
}): Promise<void> {
  const ref = parseIssueRef(payload.issueRef);
  if (!ref) return;

  // Mutations first; the announcement marks completion, so a failure here
  // leaves the run un-announced and the next sweep retries the whole step.
  if (payload.armed) {
    const disarmed = await disarmAutoMerge(ref.owner, ref.repo, payload.prNumber);
    if (!disarmed) return;
  }
  const labeled = await labelPr(ref.owner, ref.repo, payload.prNumber, HUMAN_SIGNOFF_LABEL);
  if (!labeled) return;

  db.update(runs).set({ status: "gated" }).where(eq(runs.id, payload.runId)).run();
  await releaseImplementContainer(
    payload.runId,
    "Review verdict unparseable — escalated to a human, releasing container."
  );

  announcedVerdictErrors.add(payload.runId);
  console.error(
    `[autonomy] Unparseable review verdict for ${payload.issueRef} PR #${payload.prNumber}: ${payload.reason}`
  );
  await commentOnIssue(
    payload.issueRef,
    `The review pass did not return a parseable verdict (${payload.reason}). ` +
      `Failing closed: PR #${payload.prNumber} disarmed and labelled \`${HUMAN_SIGNOFF_LABEL}\` — a human decides this one.`
  );
  await notifyReviewBlocked(getConfig().discordFleetChannelId, {
    issueRef: payload.issueRef,
    prNumber: payload.prNumber,
    reason: `review verdict unparseable: ${payload.reason}`,
  });
}

/** Release a run's parked implement container once no further turn can use it. */
async function releaseImplementContainer(runId: string, note: string): Promise<void> {
  const implementTask = implementTaskOf(runId);
  if (implementTask?.status === "running") {
    await releaseParkedImplementTask(implementTask.id, note);
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
