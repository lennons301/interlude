/**
 * The I/O shell around the pure reducer (issue #15): gather a snapshot of
 * the world, ask decideNext what to do, execute the actions. The
 * `issues.labeled` webhook and the reconciliation sweep (boot + interval)
 * both land here, so there is exactly one decision path.
 */

import { db } from "@/db";
import { messages, projects, runs, tasks } from "@/db/schema";
import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { newId } from "../../ulid";
import { processSingleton } from "../../process-singleton";
import { getConfig, PLATFORM_REPO_URL } from "../../config";
import { getFleetSettings, getSettingsOverrides } from "../../settings";
import { normalizeModelTier, type ModelTier } from "../../model-tiers";
import { getLaneCatalog } from "../../lanes/catalog";
import { resolveLane } from "../../lanes/resolve";
import { readStoredTriageResult, type RunTierChoice } from "./triage";
import { resolveQuotaThreshold, resolveResumeBound } from "../../settings-resolver";
import { evaluateQuotaGate } from "../../quota/quota-gate";
import {
  discardTranscript,
  hasTranscript,
} from "../../quota/session-transcript";
import { getOctokit, isGitHubConfigured } from "../../github/client";
import { fetchFileFromDefaultBranch } from "../../github/contents";
import {
  addLabelToIssue,
  commentOnIssue,
  listRecentIssueComments,
  parseIssueRef,
  removeLabelFromIssue,
} from "../../github/issues";
import {
  armAutoMergeSquash,
  disarmAutoMerge,
  dismissStaleReviewsAsReviewer,
  getPrState,
  labelPr,
  listChangedFiles,
  postReviewAsReviewer,
  type FailedCheck,
} from "../../github/pull-requests";
import { parseRepoFromGitUrl } from "../../github/repo";
import {
  notifyAttemptsExhausted,
  notifyDailyCapReached,
  notifyMeteredCapReached,
  notifyMeteredConfirmationRequired,
  notifyChecksEscalation,
  notifyGateConfigError,
  notifyIntegrationEscalation,
  notifyOwedReviewStalled,
  notifyPickupWedged,
  notifyQueueStale,
  notifyUndeliveredAnswer,
  notifyQuotaGateClosed,
  notifyReviewBlocked,
  notifySlotsSaturated,
  notifyStaleReviewEscalation,
  notifyTriageRecommendation,
} from "../../discord/notifications";
import { recordBacklog } from "../../fleet/backlog";
import { getFailingChecks, recordFailingChecks } from "../../fleet/failing-checks";
import { isContainerRunning, removeContainerByName } from "../../docker/container-manager";
import { observeAgentContainers } from "../../docker/agent-containers";
import { recordNeedsHuman } from "../../fleet/needs-human";
import {
  EMPTY_FLEET_HEALTH_STATE,
  evaluateFleetHealth,
  type FleetHealthInput,
  type UndeliveredAnswerObservation,
  type FleetHealthState,
  type QueuedTaskObservation,
} from "../../fleet/health";
import { recordFleetHealth } from "../../fleet/health-store";
import { readMoneyGuards } from "../../lanes/money-state";
import { getCapacity } from "../capacity";
import { getQueueLastProgress, isQueueRunning, occupiedSlots } from "../queue";
import { startOfLocalDay, todayAutonomousSpendUsd } from "../spend";
import { getActiveTasks, isParked, releaseParkedImplementTask } from "../turn-manager";
import {
  describeDefaultTier,
  describeRunTier,
  describeTierSource,
  decideNext,
  type Action,
  type AutonomySnapshot,
  type AwaitingReview,
  type CandidateIssue,
  type ChecksFailingPr,
  type ConflictingPr,
  type PausedRun,
  type PendingGateEvaluation,
  type PendingTriage,
  type PendingVerdict,
  type ResolvedCheckFailure,
  type ResolvedConflict,
  type SettledPr,
  type StaleReview,
  type TriageCandidate,
} from "./decide";
import { observeCheckRollup, type CheckObservation } from "./checks";
import { observeReviewedHead } from "./review-head";
import {
  ESTATE_GATES_PATH,
  HUMAN_SIGNOFF_LABEL,
  REPO_GATES_PATH,
  parseGateConfig,
  type GateConfig,
} from "./gates";
import {
  ADVISORY_TRIAGE_LABELS,
  ARMING_LABEL,
  NEEDS_TRIAGE_LABEL,
  READY_FOR_HUMAN_LABEL,
  labelNames,
  parseBlockedByRefs,
  rawEffortDirective,
  rawModelDirective,
} from "./ticket";
import {
  buildCiRepairPrompt,
  buildImplementPrompt,
  buildRepairPrompt,
  buildResumePrompt,
  buildReviewPrompt,
  buildTriagePrompt,
  type PriorAttempt,
} from "./workflow";
import {
  cancelOrphanedRunTasks,
  inFlightReviewTaskId,
  queuedTasksReservingSlots,
  reapDeadReviewTasks,
  runningReviewTaskId,
} from "./review-tasks";
import {
  CHECK_FAILURE_CONFIRMATION_SWEEPS,
  DAILY_AUTONOMOUS_CAP_USD,
  MAX_ATTEMPTS,
  MAX_CI_REPAIR_ATTEMPTS,
  MAX_INTEGRATION_ATTEMPTS,
  MAX_INTERRUPTIONS_PER_TICKET,
  MAX_REVIEW_CYCLES_PER_ATTEMPT,
  MAX_TRIAGE_PASSES_PER_ISSUE,
  MAX_UNPARSEABLE_REVIEW_RETRIES,
  RESUME_JITTER_WINDOW_MS,
} from "./budgets";
import { ACTIVE_RUN_STATUSES } from "../run-status";

const SWEEP_INTERVAL_MS = 30_000;

/** How deep a retry's prompt reaches into an issue's most-recent comments for
 * context (issue #73) — enough for the prior attempts' reports without
 * unbounding the prompt. Human-authored comments are kept on top of this
 * regardless of depth (selectRetryComments), so older guidance still lands. */
const RETRY_COMMENT_TAIL = 20;

const ACTIVE_RUN_STATUS_SET = new Set<string>(ACTIVE_RUN_STATUSES);

let sweepInterval: ReturnType<typeof setInterval> | null = null;
let sweeping = false;
let saturationAnnounced = false;
// Fleet-health watchdog memory (issue #126): per-signal since-timers plus which
// signals were already pinged, carried across sweeps so each stall fires one
// Discord ping, not one per 30s sweep. In-memory like the saturation/cap flags
// above — a redeploy re-arms, which is fine for a watchdog.
let fleetHealthState: FleetHealthState = EMPTY_FLEET_HEALTH_STATE;
// The local day (startOfLocalDay ms) whose cap pause was announced — keyed by
// day rather than a boolean so the announcement re-arms itself at midnight.
let dailyCapAnnouncedDay: number | null = null;
// Same, for the two money guards (issue #174): the local day whose real-money
// cap pause was announced, and the day whose spend confirmation was asked for.
// Separate from each other and from the cap above because they are separate
// news — a fleet told about its cash cap has not been asked to confirm
// anything, and vice versa.
let meteredCapAnnouncedDay: number | null = null;
let meteredConfirmationAnnouncedDay: number | null = null;
// Whether the quota gate's current closed spell has been announced (issue
// #171) — one Discord ping per transition, not one per 30s sweep, cleared the
// moment the gate opens so the *next* wall is audible again.
//
// On `globalThis` rather than beside the saturation and cap flags above, even
// though it plays the same role, because a webhook-triggered sweep runs on the
// app-router module graph (#159) where a plain module-level flag is that
// graph's own, freshly false — so one webhook arriving under a standing wall
// would double-post the embed. A Discord call is the one thing this codebase
// says must never be repeated on a maybe (#151: an abandoned call is never
// retried, because the attempt may still have landed). The older two flags are
// deliberately left as they are: they are part of the same known split, and
// moving one at a time without the sweep's other cross-graph state
// (`fleetHealthState`, `sweeping`, `inFlightClaims`) would imply a fix that is
// not there.
const quotaGateAnnouncement = processSingleton(
  "autonomy.quotaGateAnnounced",
  () => ({ announced: false })
);
const inFlightClaims = new Set<string>();
// Run IDs whose gate-config failure the owner has already been told about —
// once per failure, not once per sweep. Pruned as runs leave the pending set.
const announcedGateConfigErrors = new Set<string>();
// Same pattern for review failures: unparseable verdicts (fed back into the
// snapshot so the reducer stays one-shot) and reviews the orchestrator could
// not post (executor-level, e.g. REVIEWER_GH_TOKEN missing).
const announcedVerdictErrors = new Set<string>();
const announcedReviewPostFailures = new Set<string>();
// Run IDs whose merge-conflict escalation (issue #54) the owner has already
// been told about — once per stall, not once per sweep. Pruned as runs leave
// the conflicting set (repaired, resolved by a human, or the PR closed).
const announcedIntegrationEscalations = new Set<string>();
// Same, for a parked PR whose checks stayed red through its repairs (#130).
const announcedCheckEscalations = new Set<string>();
// Consecutive sweeps each parked run's head has been observed with a failing
// check rollup (issue #130), keyed by run id. A red rollup must be seen twice
// before it spends the run's one CI repair — see checks.ts for the fold. Pruned
// as runs leave the reviewable set; a redeploy re-arms the confirmation, which
// costs one extra sweep and never a wrong repair.
const checkObservations = new Map<string, CheckObservation>();
// Run IDs whose stale-review dismissal GitHub refused (issue #131). Fed back
// into the snapshot so the reducer — not the executor — decides that the run
// must go to a human: the loop cannot re-arm over an approval it was unable to
// withdraw. Pruned as runs leave the reviewable set, so a permission fix earns
// a fresh try on the next push.
const staleDismissalFailures = new Set<string>();
// Triage-task IDs whose unparseable exit the owner has already been told
// about — once per failure, not once per sweep. Pruned as issues leave the
// needs-triage set.
const announcedTriageErrors = new Set<string>();
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
  // The env boot master — off means no sweep runs at all, webhook-triggered or
  // interval. The runtime kill switch (issue #118) is decided inside the
  // reducer instead, so a paused fleet still gathers and still drives
  // everything already in flight.
  if (!config.autonomyEnabled) return;
  if (!isGitHubConfigured()) return;
  if (sweeping) return;
  sweeping = true;

  try {
    await reapOrphanedReviewPasses();
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

    // The quota gate's announcement, on the same pattern (issue #171) — but
    // cleared from the *gate*, not from whether the reducer paused anything.
    // The reducer only pauses when there is eligible work to hold, so clearing
    // on "no pause emitted" would re-arm the ping every time the backlog
    // emptied under a standing wall and fire it again when the next ticket was
    // armed. The gate re-opening is the transition; nothing else is.
    if (
      !evaluateQuotaGate(
        snapshot.quota,
        snapshot.quotaThresholdPercent,
        snapshot.now
      ).closed
    ) {
      quotaGateAnnouncement.announced = false;
    } else if (
      actions.some((a) => a.type === "notify" && a.event === "quota-gate-closed")
    ) {
      quotaGateAnnouncement.announced = true;
    }

    // Fleet-health watchdog (issue #126): surface silent pickup/review stalls.
    await evaluateFleetHealthSignals(snapshot, actions);
  } finally {
    sweeping = false;
  }
}

/**
 * The fleet-health watchdog (issue #126). After a sweep has decided and acted,
 * evaluate the observations that make a silent stall loud — an owed review that
 * never started, a wedged pickup, a quiet queue loop, and (issue #152) a slot
 * count no real container corroborates — record them for the dashboard's
 * needs-you cards, and fire a one-time Discord ping for any that just crossed
 * threshold. State is held across sweeps in `fleetHealthState`, the
 * same in-memory debounce the saturation/cap announcements use.
 */
async function evaluateFleetHealthSignals(
  snapshot: AutonomySnapshot,
  actions: Action[]
): Promise<void> {
  const input = await gatherFleetHealthInput(snapshot, actions);
  const { signals, announce, state } = evaluateFleetHealth(
    input,
    fleetHealthState,
    getConfig().fleetHealthThresholds
  );
  fleetHealthState = state;
  recordFleetHealth(signals);

  const channelId = getConfig().discordFleetChannelId;
  for (const stall of announce.owedReviewStalls) {
    console.warn(
      `[autonomy] Owed review stalled: ${stall.issueRef} (PR #${stall.prNumber}) — ` +
        `not started for ~${Math.round(stall.stalledForMs / 60_000)}m (${stall.reason})`
    );
    await notifyOwedReviewStalled(channelId, stall);
  }
  if (announce.pickupWedged) {
    console.warn(
      `[autonomy] Pickup wedged: ${announce.pickupWedged.detail} ` +
        `(~${Math.round(announce.pickupWedged.wedgedForMs / 60_000)}m). ` +
        announce.pickupWedged.remedy
    );
    await notifyPickupWedged(channelId, announce.pickupWedged);
  }
  for (const answer of announce.undeliveredAnswers) {
    console.warn(
      `[autonomy] Answer undelivered: ${answer.label} — queued ` +
        `~${Math.round(answer.undeliveredForMs / 60_000)}m ago and never delivered`
    );
    await notifyUndeliveredAnswer(channelId, answer);
  }
  if (announce.queueStale) {
    console.warn(
      `[autonomy] Queue heartbeat stale: no progress for ` +
        `~${Math.round(announce.queueStale.staleForMs / 60_000)}m`
    );
    await notifyQueueStale(channelId, announce.queueStale);
  }
}

/**
 * Assemble the fleet-health input from a decided sweep. The reducer snapshot is
 * left untouched (it carries only the facts the reducer needs); the extra facts
 * the watchdog wants — a review task's *running* status, a run's PR URL, the
 * queued tasks' labels, the live queue heartbeat, and what the Docker daemon
 * says is really running — are read here.
 */
async function gatherFleetHealthInput(
  snapshot: AutonomySnapshot,
  actions: Action[]
): Promise<FleetHealthInput> {
  const slotFree = snapshot.slots.occupied < snapshot.slots.total;
  const reason = owedReviewReason(snapshot.slots);

  // A run owed a review with no review *container running* — no task at all, or
  // one queued but starved of a slot. A running review is progressing, not
  // stalled, and shows under Running instead. Sourced straight from the DB
  // (not the GitHub-gated `awaitingReview` set) so a transient PR-read failure
  // that drops a run for one sweep can't reset its 30-min stall timer: any
  // reviewing/gated run with a PR, no stored/posted verdict, and no running
  // review is owed. A spent-repairs conflict has its own needs-you card
  // (classifyGated), so it is excluded here rather than double-surfaced.
  const owedReviews = db
    .select()
    .from(runs)
    .all()
    .filter(
      (r) =>
        (r.status === "reviewing" || r.status === "gated") &&
        r.pullRequestNumber != null &&
        r.reviewResult == null &&
        r.reviewVerdict == null &&
        r.integrationCount < MAX_INTEGRATION_ATTEMPTS &&
        runningReviewTaskId(db, r.id) == null
    )
    .map((r) => ({
      runId: r.id,
      issueRef: r.githubIssue,
      prNumber: r.pullRequestNumber!,
      prUrl: r.pullRequestUrl,
      reason,
    }));

  // Queued tasks that reserve a slot — the #115 incident shape (a review left
  // queued while a slot is open) and the #152 one (nothing dispatches because a
  // phantom holds the last slot). Gathered unconditionally: whether a slot
  // *reads* free is exactly the fact under suspicion, so the evaluator decides,
  // not the gatherer.
  const queuedDispatchable = gatherQueuedDispatchable();

  const pickupPausedWithFreeSlot =
    slotFree &&
    actions.some((a) => a.type === "pausePickup" && a.reason === "no-slots");

  return {
    nowMs: snapshot.now.getTime(),
    owedReviews,
    // `snapshot.slots.occupied` is `occupiedSlots()` — the in-memory counter
    // every other pickup signal trusts.
    slots: { total: snapshot.slots.total, occupied: snapshot.slots.occupied },
    pickupPausedWithFreeSlot,
    queuedDispatchable,
    // The daemon's answer to the same question, so a sustained disagreement is
    // itself a signal (#152). Null when the daemon could not be asked —
    // unknown, never divergence.
    agentContainers: await observeAgentContainers(),
    queueRunning: isQueueRunning(),
    queueLastProgressMs: getQueueLastProgress()?.getTime() ?? null,
    // An answer the owner already gave that the agent never received (issue
    // #136) — the one health signal whose clock is a DB row rather than a
    // since-timer, because the failure it detects is a restart.
    undeliveredAnswers: gatherUndeliveredAnswers(),
  };
}

/**
 * Answers queued against a live task and not yet delivered (issue #136).
 *
 * Only a live task counts: a terminal one's leftover undelivered message is
 * history, not a wait — nobody is going to answer into a completed session, and
 * surfacing those would put a permanent card on the dashboard for every session
 * ever closed mid-sentence.
 *
 * The oldest undelivered message per task is the one timed, so a card reports
 * how long the owner has actually been waiting rather than resetting each time
 * they repeat themselves — which is exactly what an owner does when nothing
 * happens (the #136 incident had the same answer sent twice, once in the UI and
 * once through Discord).
 *
 * That repetition is also why `sessionIdle` is carried rather than assumed: the
 * *second* of two answers stays undelivered for the whole of the turn the first
 * one started, so a card judged on age alone fires on a run that is working.
 * Only `container_status` distinguishes them, and the evaluator decides.
 */
function gatherUndeliveredAnswers(): UndeliveredAnswerObservation[] {
  const rows = db
    .select({
      taskId: messages.taskId,
      createdAt: messages.createdAt,
      title: tasks.title,
      kind: tasks.kind,
      githubIssue: tasks.githubIssue,
      containerStatus: tasks.containerStatus,
    })
    .from(messages)
    .innerJoin(tasks, eq(tasks.id, messages.taskId))
    .where(
      and(
        eq(messages.role, "user"),
        isNull(messages.deliveredAt),
        inArray(tasks.status, ["queued", "running", "blocked"])
      )
    )
    .orderBy(asc(messages.createdAt))
    .all();

  const oldest = new Map<string, UndeliveredAnswerObservation>();
  for (const row of rows) {
    if (oldest.has(row.taskId)) continue;
    oldest.set(row.taskId, {
      taskId: row.taskId,
      label: `${row.kind}: ${row.githubIssue ?? row.title}`,
      issueRef: row.githubIssue,
      taskUrl: `/tasks/${row.taskId}`,
      queuedAtMs: row.createdAt.getTime(),
      sessionIdle: row.containerStatus === "idle",
    });
  }
  return [...oldest.values()];
}

/** Why an owed review can't run right now, for the stalled-review card body. */
function owedReviewReason(slots: AutonomySnapshot["slots"]): string {
  if (slots.occupied < slots.total) {
    return "a slot is free but the review is not dispatching";
  }
  if (slots.occupants.some((o) => o.startsWith("interactive:"))) {
    return `a slot is held by an interactive session (${slots.occupied}/${slots.total} busy)`;
  }
  return `all ${slots.total} slot${slots.total === 1 ? "" : "s"} busy`;
}

/** Queued tasks that reserve a slot (interactive/triage, or a pass under a live
 * run) with a label for the wedged-pickup card. Mirrors the reservation filter
 * gatherSnapshot uses for claim accounting (issue #124), so a dead-run orphan is
 * never counted as dispatchable work. */
function gatherQueuedDispatchable(): QueuedTaskObservation[] {
  const liveRunIds = new Set(
    db
      .select({ id: runs.id, status: runs.status })
      .from(runs)
      .all()
      .filter((r) => ACTIVE_RUN_STATUS_SET.has(r.status))
      .map((r) => r.id)
  );
  const queued = db
    .select({
      id: tasks.id,
      kind: tasks.kind,
      runId: tasks.runId,
      title: tasks.title,
      githubIssue: tasks.githubIssue,
    })
    .from(tasks)
    .where(eq(tasks.status, "queued"))
    .all();
  return queuedTasksReservingSlots(queued, liveRunIds).map((t) => ({
    taskId: t.id,
    label: `${t.kind}: ${t.githubIssue ?? t.title}`,
  }));
}

/**
 * The ungraceful-death half of the exactly-one-review invariant (issue #95),
 * run before every gather. A review pass whose container was OOM-killed or lost
 * while the daemon hung can leave its task stuck `running` with no status
 * transition; keyed on task status alone, the in-flight check would read it as
 * live forever — the run stalls, and any re-queue races a duplicate. Confirm
 * each such task's container is actually gone (the Docker probe fails safe:
 * only a definitively dead container is reaped, a transient daemon error is
 * left for the next sweep), mark it `failed`, then drop its in-memory session
 * entry and remove the dead container so it holds neither a phantom slot nor
 * leaked memory — the ordinary reaper protects live-run containers, so nothing
 * else would clean this one up while the run is still `reviewing`.
 */
async function reapOrphanedReviewPasses(): Promise<void> {
  const reaped = await reapDeadReviewTasks(db, isContainerRunning);
  for (const task of reaped) {
    getActiveTasks().delete(task.taskId);
    if (task.containerName) await removeContainerByName(task.containerName);
    // An anomaly worth surfacing (a container died ungracefully) but not a
    // sweep failure — the reaper is recovering it cleanly.
    console.warn(
      `[autonomy] Reaped review task ${task.taskId}: container gone but task still ` +
        `running — marked failed so a single replacement review can be queued`
    );
  }
}

async function gatherSnapshot(now: Date): Promise<AutonomySnapshot> {
  const config = getConfig();
  // One read of the settings row per tick, for every runtime flag it carries:
  // the kill switch (issue #118), the quota threshold override (issue #171)
  // and the money guards' cap and confirmation (issue #174). One read, because
  // they must all describe the same instant — and read here rather than cached
  // anywhere, which is what makes a change on the settings screen take effect
  // at the next sweep.
  const settings = getFleetSettings();
  const capacity = await getCapacity();

  // Which lane work would run on, who pays for it, and what it has cost today
  // — read every tick from the checked-in catalog plus the *current*
  // overrides, which is what makes switching the primary lane between billing
  // kinds take effect at the next sweep with no restart. The same read the
  // dashboard and the settings panel make, so all three describe one fleet.
  const money = readMoneyGuards(now, settings);

  const registered = db
    .select()
    .from(projects)
    .where(isNotNull(projects.githubRepo))
    .all();

  const allRuns = db.select().from(runs).all();

  // The queued tasks that reserve a slot for pickup accounting (issue #124):
  // only those whose run is still live, plus run-less passes (interactive,
  // triage). A task left `queued` under a now-terminal run — the review a
  // hand-merged PR orphaned — is dropped here so it can never suppress a new
  // claim while a slot sits free (the LPS #135 wedge). `runId` is carried
  // solely for this filter.
  const liveRunIds = new Set(
    allRuns.filter((r) => ACTIVE_RUN_STATUS_SET.has(r.status)).map((r) => r.id)
  );
  const queuedTasks = queuedTasksReservingSlots(
    db
      .select({ kind: tasks.kind, runId: tasks.runId })
      .from(tasks)
      .where(eq(tasks.status, "queued"))
      .all(),
    liveRunIds
  );

  // Occupant labels for the saturation announcement. Parked containers
  // (implement passes idling while their PR is reviewed) hold no slot.
  const occupants: string[] = [];
  for (const [taskId, entry] of getActiveTasks()) {
    if (isParked(entry)) continue;
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (task) occupants.push(`${task.kind}: ${task.githubIssue ?? task.title}`);
  }

  const candidates: CandidateIssue[] = [];
  const triageCandidates: TriageCandidate[] = [];
  const pendingTriageResults: PendingTriage[] = [];
  const octokit = await getOctokit();

  for (const project of registered) {
    const repoFullName = project.githubRepo!;
    const [owner, repo] = repoFullName.split("/");
    if (!owner || !repo) continue;

    // The needs-triage listing is the triage queue: new issues are marked by
    // the issues.opened webhook, strays by whoever labelled them. One issue
    // is at most one thing here — in flight (a pass queued or running),
    // pending (a stored exit awaiting application), or a candidate. Stored
    // exits are consumed when acted on — applied or announced-unparseable —
    // so an issue that carries the label again (a retry, or a human
    // re-queueing after questions were answered) becomes a candidate for a
    // fresh pass, never a replay of a stale exit, bounded by the lifetime
    // pass count: past it the issue sits visibly labelled for a human,
    // never in a spend loop.
    try {
      const { data: strays } = await octokit.rest.issues.listForRepo({
        owner,
        repo,
        labels: NEEDS_TRIAGE_LABEL,
        state: "open",
        per_page: 100,
      });

      for (const issue of strays) {
        if (issue.pull_request) continue;
        const issueRef = `${repoFullName}#${issue.number}`;

        const triageTasks = db
          .select()
          .from(tasks)
          .where(and(eq(tasks.githubIssue, issueRef), eq(tasks.kind, "triage")))
          .all();
        const inFlight = triageTasks.some(
          (t) => t.status === "queued" || t.status === "running"
        );
        const stored = triageTasks
          .filter((t) => t.triageResult != null)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .pop();

        if (!inFlight && stored) {
          pendingTriageResults.push({
            taskId: stored.id,
            issueRef,
            issueTitle: issue.title,
            issueBody: issue.body ?? "",
            projectId: project.id,
            result: readStoredTriageResult(stored.triageResult!),
          });
        } else if (inFlight || triageTasks.length < MAX_TRIAGE_PASSES_PER_ISSUE) {
          triageCandidates.push({
            issueRef,
            repo: repoFullName,
            number: issue.number,
            title: issue.title,
            body: issue.body ?? "",
            author: issue.user?.login ?? "",
            hasTriageTask: inFlight,
          });
        }
      }
    } catch (err) {
      console.error(`[autonomy] Failed to list needs-triage issues for ${repoFullName}:`, err);
    }

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
        const hasActiveRun = issueRuns.some((r) => ACTIVE_RUN_STATUS_SET.has(r.status));
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
          interruptionsMade: issueRuns.filter((r) => r.status === "interrupted").length,
          hasActiveRun,
          triageTier: latestTriageTier(issueRef),
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

    // The open `ready-for-human` set — the read model retires an exhausted
    // needs-you card once its issue leaves this set (a human closed it or
    // dropped the label). Recorded only on success, so a transient API error
    // can't wrongly clear a card; the 7-day window remains the safe backstop.
    try {
      const { data: waiting } = await octokit.rest.issues.listForRepo({
        owner,
        repo,
        labels: READY_FOR_HUMAN_LABEL,
        state: "open",
        per_page: 100,
      });
      const refs = waiting
        .filter((issue) => !issue.pull_request)
        .map((issue) => `${repoFullName}#${issue.number}`);
      recordNeedsHuman(project.id, refs);
    } catch (err) {
      console.error(
        `[autonomy] Failed to list ready-for-human issues for ${repoFullName}:`,
        err
      );
    }
  }

  const reviewState = await gatherReviewState(allRuns);

  // The owner is re-told about an unparseable triage exit only if its issue
  // left the needs-triage set and somehow returned; otherwise one
  // announcement stands.
  for (const taskId of [...announcedTriageErrors]) {
    if (!pendingTriageResults.some((p) => p.taskId === taskId)) {
      announcedTriageErrors.delete(taskId);
    }
  }

  return {
    now,
    autonomyEnabledGlobal: config.autonomyEnabled,
    // From the row read fresh above, never cached or captured at boot: that is
    // what makes the kill switch (issue #118) take effect at the next sweep
    // rather than at the next restart.
    globalPaused: settings.globalAutonomyPaused,
    // The last observation a pass on the lane *this* tick would claim onto
    // wrote (issue #167, per-lane since #175), and the threshold in force.
    // Both read fresh each tick, never captured at boot: that is what lets a
    // wall observed mid-sweep, or a threshold or lane changed on the settings
    // screen, take effect at the next tick rather than at the next restart.
    //
    // Per-lane is what keeps the gate honest, not a refinement of it: the
    // unified-window machinery is subscription-only, so a metered lane never
    // produces an observation at all. Read fleet-wide, the subscription's last
    // rejection would close the gate over a lane that cannot be rate-limited —
    // holding every pickup on a fleet that was, on that lane, entirely free to
    // work. The gate already treats no observation as open (see its rule 1),
    // so asking the right lane is the whole fix. It comes from the one read
    // this tick already made for the money guards (issue #174), which is keyed
    // to the lane they resolved — so the lane whose quota is judged, the lane
    // whose spend is capped, and the lane an overage is read against
    // (issue #173) can never be three different lanes.
    quota: money.quota,
    quotaThresholdPercent: resolveQuotaThreshold(config, settings.overrides)
      .percent,
    quotaGateAnnounced: quotaGateAnnouncement.announced,
    // MAX_BUDGET_USD is the per-attempt default since Phase 5 (a ticket's
    // budget: directive may raise a single attempt to the $75 ceiling)
    attemptBudgetUsd: config.maxBudgetUsd,
    maxAttempts: MAX_ATTEMPTS,
    maxInterruptions: MAX_INTERRUPTIONS_PER_TICKET,
    maxReviewCycles: MAX_REVIEW_CYCLES_PER_ATTEMPT,
    maxUnparseableRetries: MAX_UNPARSEABLE_REVIEW_RETRIES,
    maxIntegrationAttempts: MAX_INTEGRATION_ATTEMPTS,
    todayAutonomousSpendUsd: todayAutonomousSpendUsd(now),
    dailyCapUsd: DAILY_AUTONOMOUS_CAP_USD,
    dailyCapAnnounced: dailyCapAnnouncedDay === startOfLocalDay(now).getTime(),
    primaryLaneId: money.lane?.id ?? null,
    // The *effective* kind (issue #173): an active overage means the account
    // is already paying cash for subscription-lane work, and the guards must
    // see that or the wall silently becomes a bill.
    primaryLaneBilling: money.billing,
    meteredSpendTodayUsd: money.spentTodayUsd,
    meteredCapUsd: money.cap.capUsd,
    meteredSpendConfirmedAt: settings.meteredSpendConfirmedAt,
    // Both keyed by local day rather than by a boolean, exactly as the daily
    // cap's is, so each announcement re-arms itself at midnight.
    meteredCapAnnounced: meteredCapAnnouncedDay === startOfLocalDay(now).getTime(),
    meteredConfirmationAnnounced:
      meteredConfirmationAnnouncedDay === startOfLocalDay(now).getTime(),
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
    conflictingPrs: reviewState.conflictingPrs,
    resolvedConflicts: reviewState.resolvedConflicts,
    checksFailingPrs: reviewState.checksFailingPrs,
    resolvedCheckFailures: reviewState.resolvedCheckFailures,
    staleReviews: reviewState.staleReviews,
    maxCiRepairAttempts: MAX_CI_REPAIR_ATTEMPTS,
    minCheckFailureSweeps: CHECK_FAILURE_CONFIRMATION_SWEEPS,
    announcedCheckEscalations: [...announcedCheckEscalations],
    // Both repair kinds queue a `repair` task, so this reserves the slot for a
    // conflict repair and a CI repair alike.
    queuedRepairCount: queuedTasks.filter((t) => t.kind === "repair").length,
    announcedIntegrationEscalations: [...announcedIntegrationEscalations],
    triageCandidates,
    pendingTriageResults,
    queuedTriageCount: queuedTasks.filter((t) => t.kind === "triage").length,
    announcedTriageErrors: [...announcedTriageErrors],
    pausedRuns: gatherPausedRuns(allRuns),
    // Off the same one-per-tick read of the settings row as the threshold
    // above, never the memoised config: a bound changed on the settings screen
    // must bind at the next sweep with no restart (issue #166's freshness
    // rule, which lives at the call site).
    maxResumesPerAttempt: resolveResumeBound(config, settings.overrides).resumes,
    resumeJitterMs: RESUME_JITTER_WINDOW_MS,
  };
}

/**
 * Runs parked on the quota clock (issue #169), with the two facts the reducer
 * decides from: how many resumes this attempt has spent, and whether one is
 * already under way.
 *
 * `hasLiveTask` is the idempotency latch and is deliberately a *task* fact
 * rather than a run-status one: the resume executor leaves the run
 * `rate_limited` until its pass actually starts, so that a restart between the
 * two leaves a paused run that is still visibly paused rather than one
 * pretending to be claimed.
 */
function gatherPausedRuns(allRuns: Array<typeof runs.$inferSelect>): PausedRun[] {
  const paused = allRuns.filter((run) => run.status === "rate_limited");
  if (paused.length === 0) return [];

  // One query for every paused run, as the sibling gatherers do — a sweep runs
  // every 30 seconds and its cost should not scale with how walled the account
  // happens to be.
  const resuming = new Set(
    db
      .select({ runId: tasks.runId })
      .from(tasks)
      .where(
        and(
          inArray(
            tasks.runId,
            paused.map((run) => run.id)
          ),
          inArray(tasks.status, ["queued", "running"])
        )
      )
      .all()
      .map((task) => task.runId)
  );

  return paused.map((run) => ({
    runId: run.id,
    issueRef: run.githubIssue,
    resumeAfter: run.resumeAfter,
    resumesMade: run.resumeCount,
    hasLiveTask: resuming.has(run.id),
  }));
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
  conflictingPrs: ConflictingPr[];
  resolvedConflicts: ResolvedConflict[];
  checksFailingPrs: ChecksFailingPr[];
  resolvedCheckFailures: ResolvedCheckFailure[];
  staleReviews: StaleReview[];
}> {
  const awaitingReview: AwaitingReview[] = [];
  const pendingVerdicts: PendingVerdict[] = [];
  const settledPrs: SettledPr[] = [];
  const conflictingPrs: ConflictingPr[] = [];
  const resolvedConflicts: ResolvedConflict[] = [];
  const checksFailingPrs: ChecksFailingPr[] = [];
  const resolvedCheckFailures: ResolvedCheckFailure[] = [];
  const staleReviews: StaleReview[] = [];
  // What the dashboard and digest render as the failing-checks needs-you card
  // (issue #130): the names observed red this sweep, recorded wholesale below so
  // a rollup that went green simply stops appearing. A run whose PR read failed
  // carries its last observation forward instead of blinking the card off for a
  // sweep — the same rule the needs-human store states: a failed read is not
  // evidence of a changed state.
  const previousFailingChecks = getFailingChecks();
  const failingChecksByRun: Record<string, string[]> = {};

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
  // The conflict escalation is likewise re-announced only if the run leaves
  // the reviewing/gated set and returns — a run being repaired is
  // `implementing`, so this prunes as soon as a repair or a human's fix moves
  // the PR back to mergeable (or closes it).
  for (const runId of [...announcedIntegrationEscalations]) {
    if (!reviewable.some((r) => r.id === runId)) {
      announcedIntegrationEscalations.delete(runId);
    }
  }
  // The failing-checks escalation (issue #130) prunes the same way, and so does
  // the confirmation memory: a run being CI-repaired is `implementing`, so both
  // are dropped as soon as the repair starts and the next episode is judged on
  // its own observations.
  for (const runId of [...announcedCheckEscalations]) {
    if (!reviewable.some((r) => r.id === runId)) announcedCheckEscalations.delete(runId);
  }
  for (const runId of [...checkObservations.keys()]) {
    if (!reviewable.some((r) => r.id === runId)) checkObservations.delete(runId);
  }
  for (const runId of [...staleDismissalFailures]) {
    if (!reviewable.some((r) => r.id === runId)) staleDismissalFailures.delete(runId);
  }

  for (const run of reviewable) {
    const ref = parseIssueRef(run.githubIssue);
    if (!ref) continue;

    const pr = await getPrState(ref.owner, ref.repo, run.pullRequestNumber!);
    if (!pr) {
      const stillRed = previousFailingChecks?.[run.id];
      if (stillRed) failingChecksByRun[run.id] = stillRed;
      continue;
    }

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

    // The reviewed commit moved (issue #131): a human clicked *Update branch*,
    // pushed a commit, or merged the default branch in after the verdict was
    // posted, so the standing approval is about code nobody reviewed.
    //
    // This outranks both repair branches below, because the half that must not
    // wait is the safety half — disarm, and withdraw the review GitHub is still
    // counting. A repair clears the run's review state (including the reviewed
    // SHA) without touching either, so letting a repair go first would lose the
    // record of what was reviewed while the approval stayed standing, and the
    // repair's own push would then be auto-merged over it. #130's ordering rule
    // still holds: this branch queues no review pass, and once the run comes
    // back through gate evaluation a red rollup diverts it to a CI repair before
    // any review is queued — so no review still runs against a branch that does
    // not compile. It yields to a stored verdict (the `reviewResult` guard,
    // which is what "below the stored-verdict branch" means here) for the reason
    // #130 gives: a finished verdict reaches GitHub before its state is cleared,
    // and posting it re-stamps the reviewed SHA anyway.
    const moved = observeReviewedHead(run.reviewedHeadSha, pr.headSha);
    if (moved && run.reviewResult == null) {
      staleReviews.push({
        runId: run.id,
        issueRef: run.githubIssue,
        prNumber: run.pullRequestNumber!,
        armed,
        reviewedHeadSha: moved.reviewedHeadSha,
        headSha: moved.headSha,
        reviewCycleCount: run.reviewCycleCount,
        dismissalFailed: staleDismissalFailures.has(run.id),
      });
      // The rollup is not read on this path, so keep the last observation rather
      // than blinking the needs-you card off for a sweep (the same rule the
      // needs-human store states: not looking is not evidence of a change).
      const stillRed = previousFailingChecks?.[run.id];
      if (stillRed) failingChecksByRun[run.id] = stillRed;
      continue;
    }

    // Integration (issue #54): a parked PR the tracker reports CONFLICTING is
    // repaired or escalated ahead of the review pipeline — reviewing a PR that
    // cannot merge is wasted work, and the repair re-triggers review on its
    // push. `unknown` mergeability is re-polled next sweep, never a verdict.
    if (pr.mergeable === "conflicting") {
      conflictingPrs.push({
        runId: run.id,
        issueRef: run.githubIssue,
        prNumber: run.pullRequestNumber!,
        armed,
        integrationsMade: run.integrationCount,
        hasRepairTask: hasInFlightRepairTask(run.id),
      });
      continue;
    }
    // A repaired PR that is mergeable again ends its conflict episode: the
    // reset lets a later, unrelated conflict earn its own repairs. It still
    // proceeds through the normal pipeline below.
    if (pr.mergeable === "mergeable" && run.integrationCount > 0) {
      resolvedConflicts.push({ runId: run.id, issueRef: run.githubIssue });
    }

    // CI health (issue #130): a parked PR that merges cleanly but whose checks
    // are red is the same invisible stall as a conflict — an armed run's
    // auto-merge silently never fires, a gated one waits on a human nobody told.
    // Only a *textually mergeable* PR is judged here: while mergeability is
    // still `unknown` the PR may yet turn out to conflict, and a CI repair pass
    // (whose prompt says the merge is clean and forbids merging anything in)
    // would be the wrong pass — so an unknown reads as no observation and is
    // re-polled, exactly like a pending rollup.
    let checksFailing: ChecksFailingPr | null = null;
    if (pr.mergeable === "mergeable") {
      const observation = observeCheckRollup(
        checkObservations.get(run.id),
        pr.headSha,
        pr.checks.state
      );
      if (observation) {
        checkObservations.set(run.id, observation);
        failingChecksByRun[run.id] = pr.checks.failed.map((check) => check.name);
        // A review pass already in flight holds this run's container slot; let it
        // finish and repair CI on a later sweep rather than double-booking the
        // run (the review pipeline below is a no-op while its task is in flight).
        if (inFlightReviewTaskId(db, run.id) == null) {
          checksFailing = {
            runId: run.id,
            issueRef: run.githubIssue,
            prNumber: run.pullRequestNumber!,
            headSha: pr.headSha,
            armed,
            failedChecks: pr.checks.failed,
            sweepsFailing: observation.sweepsFailing,
            ciRepairsMade: run.ciRepairCount,
            hasRepairTask: hasInFlightRepairTask(run.id),
          };
        }
      } else {
        checkObservations.delete(run.id);
        // A green rollup ends the CI-repair episode, so a later unrelated failure
        // earns its own repair instead of escalating on a spent count. Only
        // `passing` counts: pending and unreadable rollups are not evidence.
        if (pr.checks.state === "passing" && run.ciRepairCount > 0) {
          resolvedCheckFailures.push({ runId: run.id, issueRef: run.githubIssue });
        }
      }
    }

    if (run.reviewResult != null) {
      pendingVerdicts.push({
        runId: run.id,
        issueRef: run.githubIssue,
        prNumber: run.pullRequestNumber!,
        armed,
        result: run.reviewResult,
        headSha: pr.headSha,
        implementTaskId: liveImplementTaskId(run.id),
        reviewCycleCount: run.reviewCycleCount,
        reviewUnparseableCount: run.reviewUnparseableCount,
      });
      continue;
    }

    // Red checks are repaired here, after a finished verdict has been posted but
    // ahead of any *new* review work (issue #130): the reducer must never queue a
    // review pass against a branch that does not compile, and the repair's push
    // re-triggers gate evaluation and review once it is green. Sitting below the
    // stored-verdict branch is what keeps a reviewer's finished verdict from
    // being thrown away — the repair clears the run's review state, so a verdict
    // caught mid-flight would otherwise never reach GitHub.
    if (checksFailing) {
      checksFailingPrs.push(checksFailing);
      continue;
    }

    // A posted verdict with no new result means the run waits on GitHub (an
    // armed approval auto-merging) or on a human (a gated PR) — nothing to do.
    if (run.reviewVerdict != null) continue;

    // A review task queued or running for this run means one is already in
    // flight — don't queue a second (issue #45). A dead-but-stuck-`running`
    // task is cleared by reapOrphanedReviewPasses before this gather, so it
    // stops reading as in flight and the run gets one deliberate replacement
    // rather than stalling here forever (issue #95).
    awaitingReview.push({
      runId: run.id,
      issueRef: run.githubIssue,
      prNumber: run.pullRequestNumber!,
      armed,
      hasReviewTask: inFlightReviewTaskId(db, run.id) != null,
    });
  }

  recordFailingChecks(failingChecksByRun);

  return {
    awaitingReview,
    pendingVerdicts,
    settledPrs,
    conflictingPrs,
    resolvedConflicts,
    checksFailingPrs,
    resolvedCheckFailures,
    staleReviews,
  };
}

/**
 * A run's current working pass: its implement pass, or the integration-repair
 * pass (issue #54) that supersedes it once a conflict is being merged out. The
 * most recently created of the two is the live one, so gate evaluation, fix-up
 * delivery and container release all follow it rather than a stale earlier
 * pass (a repaired run has both an old, completed implement task and a live
 * repair task).
 */
/** The failing checks as prose for a log line, issue comment or Discord ping. */
function checkNames(failedChecks: FailedCheck[]): string {
  return failedChecks.map((check) => check.name).join(", ");
}

/**
 * Whether a repair pass is already queued or running for this run — the
 * idempotency anchor both repair kinds share (a merge-conflict repair, issue
 * #54, and a CI repair, issue #130), so neither can queue a second one while the
 * first is in flight.
 */
function hasInFlightRepairTask(runId: string): boolean {
  return (
    db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.runId, runId),
          eq(tasks.kind, "repair"),
          inArray(tasks.status, ["queued", "running"])
        )
      )
      .get() != null
  );
}

function workingTaskOf(runId: string) {
  return db
    .select({ id: tasks.id, status: tasks.status, containerStatus: tasks.containerStatus })
    .from(tasks)
    .where(and(eq(tasks.runId, runId), inArray(tasks.kind, ["implement", "repair"])))
    .orderBy(desc(tasks.createdAt))
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
  const workingTask = workingTaskOf(runId);
  if (!workingTask) return false;

  const settled =
    workingTask.status === "running"
      ? workingTask.containerStatus === "idle"
      : workingTask.status === "completed" || workingTask.status === "failed";
  if (!settled) return false;

  const undelivered = db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.taskId, workingTask.id),
        eq(messages.role, "user"),
        isNull(messages.deliveredAt)
      )
    )
    .get();
  return undelivered == null;
}

/** The run's working task (implement or repair), if its container is still
 * alive to take a fix-up turn. */
function liveImplementTaskId(runId: string): string | null {
  const workingTask = workingTaskOf(runId);
  if (!workingTask || workingTask.status !== "running") return null;
  return getActiveTasks().has(workingTask.id) ? workingTask.id : null;
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
      checkpoint: run.checkpoint,
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

/**
 * The tier the issue's most recent *completed* triage pass suggested for its
 * work (issue #200), or null when it suggested none. Read off
 * `tasks.triageTier`, which outlives the exit's consumption for exactly this
 * read: the claim may come hours after the pass, on a human's label click or
 * Discord "yes". The newest pass that ran to completion decides, a null
 * included — a re-triage that omitted the line means "the default", not
 * "whatever an earlier pass said about an earlier body" — while a pass that
 * died (`failed`, no exit) says nothing and leaves the last judgement
 * standing. The status is a safe key because `finishTriagePass` writes the
 * exit and `completed` in one statement: every pass the pending-triage gather
 * above applied by its stored exit is `completed` from the same instant, and
 * the only `failed` rows holding a result are the ones the turn manager's
 * catch wrote for a pass that died — which the gather applies fail-closed and
 * this read skips, so the embed and the claim always name the same pass. The
 * stored word is re-clamped to the vocabulary on the way in: a row is data,
 * and the reducer only ever sees a tier.
 */
function latestTriageTier(issueRef: string): ModelTier | null {
  const row = db
    .select({ tier: tasks.triageTier })
    .from(tasks)
    .where(
      and(eq(tasks.githubIssue, issueRef), eq(tasks.kind, "triage"), eq(tasks.status, "completed"))
    )
    .orderBy(desc(tasks.createdAt))
    .limit(1)
    .get();
  return normalizeModelTier(row?.tier ?? null);
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
  // Same pattern for triage: a recommendation is only pinged to Discord once
  // its applyTriage landed, or a retried apply would ping the owner twice.
  const failedTriageApplies = new Set<string>();

  for (const action of actions) {
    switch (action.type) {
      case "claimIssue":
        await executeClaim(action);
        break;
      case "startTriage":
        await executeStartTriage(action);
        break;
      case "applyTriage": {
        const applied = await executeApplyTriage(action);
        if (!applied) failedTriageApplies.add(action.taskId);
        break;
      }
      case "gatePr":
        await executeGatePr(action);
        break;
      case "armAutoMerge":
        await executeArmAutoMerge(action);
        break;
      case "startReview":
        await executeStartReview(action);
        break;
      case "retryReview":
        await executeRetryReview(action);
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
      case "repairPr":
        await executeRepairPr(action);
        break;
      case "escalateConflict":
        await executeEscalateConflict(action);
        break;
      case "clearIntegration":
        executeClearIntegration(action);
        break;
      case "repairChecks":
        await executeRepairChecks(action);
        break;
      case "escalateChecks":
        await executeEscalateChecks(action);
        break;
      case "clearCiRepair":
        executeClearCiRepair(action);
        break;
      case "invalidateReview":
        await executeInvalidateReview(action);
        break;
      case "escalateStaleReview":
        await executeEscalateStaleReview(action);
        break;
      case "exhaust":
        await executeExhaust(action);
        break;
      case "resumeRun":
        await executeResumeRun(action);
        break;
      case "exhaustPausedRun":
        await executeExhaustPausedRun(action);
        break;
      case "failAttempt":
        await executeFailAttempt(action);
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
        } else if (action.event === "daily-cap-reached") {
          console.log(
            `[autonomy] Daily cap reached ($${action.payload.spentUsd.toFixed(2)} / ` +
              `$${action.payload.capUsd.toFixed(2)}) — pickup paused until local midnight`
          );
          dailyCapAnnouncedDay = startOfLocalDay(new Date()).getTime();
          await notifyDailyCapReached(getConfig().discordFleetChannelId, action.payload);
        } else if (action.event === "metered-cap-reached") {
          console.log(
            `[autonomy] Real-money cap reached ($${action.payload.spentUsd.toFixed(2)} / ` +
              `$${action.payload.capUsd.toFixed(2)} on ${action.payload.laneId ?? "a metered lane"}) ` +
              `— pickup paused until local midnight`
          );
          meteredCapAnnouncedDay = startOfLocalDay(new Date()).getTime();
          await notifyMeteredCapReached(
            getConfig().discordFleetChannelId,
            action.payload
          );
        } else if (action.event === "metered-confirmation-required") {
          console.log(
            `[autonomy] Pickup held: ${action.payload.laneId ?? "the primary lane"} bills real ` +
              `money and today's spend is unconfirmed (cap $${action.payload.capUsd.toFixed(2)})`
          );
          meteredConfirmationAnnouncedDay = startOfLocalDay(new Date()).getTime();
          await notifyMeteredConfirmationRequired(
            getConfig().discordFleetChannelId,
            action.payload
          );
        } else if (action.event === "quota-gate-closed") {
          const { utilization, thresholdPercent, status, heldTickets } =
            action.payload;
          console.log(
            `[autonomy] Quota gate closed (${status}` +
              `${utilization === null ? "" : `, ${utilization}% used`}` +
              `, threshold ${thresholdPercent}%) — ${heldTickets} armed ` +
              `ticket(s) held; work in flight continues`
          );
          await notifyQuotaGateClosed(
            getConfig().discordFleetChannelId,
            action.payload
          );
        } else if (action.event === "gate-config-error") {
          await executeGateConfigError(action.payload);
        } else if (action.event === "verdict-unparseable") {
          await executeVerdictUnparseable(action.payload);
        } else if (action.event === "triage-recommendation") {
          if (!failedTriageApplies.has(action.payload.taskId)) {
            await executeTriageRecommendation(action.payload);
          }
        } else if (action.event === "triage-unparseable") {
          await executeTriageUnparseable(action.payload);
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
 * that follows judges the PR as it now stands. A supervised run's comment
 * leads with the checkpoint — the decision the owner is being waited on —
 * rather than the (possibly empty) gate categories.
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
      reviewedHeadSha: null,
    })
    .where(eq(runs.id, action.runId))
    .run();

  const gatedBy = [
    ...(action.checkpoint !== null ? ["checkpoint"] : []),
    ...action.categories,
  ];
  console.log(
    `[autonomy] Gated ${action.issueRef} PR #${action.prNumber}: ${gatedBy.join(", ")}`
  );

  if (action.checkpoint !== null) {
    const lines = [
      `Checkpoint: this ticket runs supervised — PR #${action.prNumber} is labelled ` +
        `\`${HUMAN_SIGNOFF_LABEL}\` with auto-merge left disarmed, regardless of gate ` +
        `matches. A human approves and merges this one.`,
    ];
    if (action.checkpoint.trim()) {
      lines.push(`The decision waiting:\n\n> ${action.checkpoint.trim()}`);
    }
    if (action.categories.length > 0) {
      lines.push(`It also touches **${action.categories.join(", ")}**.`);
    }
    await commentOnIssue(action.issueRef, lines.join("\n\n"));
    return;
  }

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
      reviewedHeadSha: null,
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

  const taskId = await queueReviewTask(run, ref, action.prNumber, action.armed);
  if (taskId) {
    console.log(
      `[autonomy] Queued review of ${action.issueRef} PR #${action.prNumber} -> task ${taskId}`
    );
  }
}

/**
 * Re-queue a review pass after an unparseable verdict (issue #89): a bounded
 * one-shot that feeds the parse failure back so the pass can restate its
 * verdict in shape, rather than a pure format slip costing a human's time. The
 * stored result and the retry count are only touched once the new task is in
 * the queue — a GitHub read failure leaves the unparseable result in place so
 * the next sweep retries the whole step without burning the retry.
 */
async function executeRetryReview(
  action: Extract<Action, { type: "retryReview" }>
): Promise<void> {
  const ref = parseIssueRef(action.issueRef);
  if (!ref) return;

  const run = db.select().from(runs).where(eq(runs.id, action.runId)).get();
  if (!run) return;

  const taskId = await queueReviewTask(
    run,
    ref,
    action.prNumber,
    action.armed,
    action.parseFailure
  );
  if (!taskId) return;

  db.update(runs)
    .set({
      reviewResult: null,
      reviewUnparseableCount: run.reviewUnparseableCount + 1,
    })
    .where(eq(runs.id, run.id))
    .run();

  console.log(
    `[autonomy] Re-queued review of ${action.issueRef} PR #${action.prNumber} ` +
      `after unparseable verdict -> task ${taskId}`
  );
}

/**
 * Queue one review-pass task for a run: read the live issue, build the prompt
 * from the vendored reviewer definition (never from anything a container
 * wrote), and insert the task. `parseFailure` is set only on a retry after an
 * unparseable verdict (issue #89). Returns the new task ID, or null if the
 * GitHub read or definition load failed — the caller leaves the run untouched
 * so the next sweep retries.
 */
async function queueReviewTask(
  run: typeof runs.$inferSelect,
  ref: { owner: string; repo: string; number: number },
  prNumber: number,
  armed: boolean,
  parseFailure?: string
): Promise<string | null> {
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
      prNumber,
      armed,
      parseFailure,
    });

    const now = new Date();
    const taskId = newId();
    db.insert(tasks)
      .values({
        id: taskId,
        projectId: run.projectId,
        title: `Review PR #${prNumber}: ${issue.title}`,
        description: prompt,
        status: "queued",
        kind: "review",
        runId: run.id,
        githubIssue: `${ref.owner}/${ref.repo}#${ref.number}`,
        branch,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    return taskId;
  } catch (err) {
    // Missing reviewer definition or a GitHub read failure: the run stays
    // awaiting review and the next sweep retries.
    console.error(
      `[autonomy] Failed to queue review for ${ref.owner}/${ref.repo}#${ref.number}:`,
      err
    );
    return null;
  }
}

/**
 * Queue a triage pass: a short, cheap, read-only unit of work drawing a slot
 * like any other pass, in its own container with the repo as reading
 * material. The prompt is built here from the vendored pass definition and
 * the live issue — never from anything a container wrote. The pass receives
 * no credential beyond the App token its setup uses for cloning, and not
 * the project's Doppler secrets.
 */
async function executeStartTriage(
  action: Extract<Action, { type: "startTriage" }>
): Promise<void> {
  const ref = parseIssueRef(action.issueRef);
  if (!ref) return;

  try {
    const prompt = buildTriagePrompt({
      repo: `${ref.owner}/${ref.repo}`,
      issueNumber: action.issueNumber,
      issueTitle: action.issueTitle,
      issueBody: action.issueBody,
    });

    const now = new Date();
    const taskId = newId();
    db.insert(tasks)
      .values({
        id: taskId,
        projectId: action.projectId,
        title: `Triage: ${action.issueTitle}`,
        description: prompt,
        status: "queued",
        kind: "triage",
        githubIssue: action.issueRef,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    console.log(`[autonomy] Queued triage of ${action.issueRef} -> task ${taskId}`);
  } catch (err) {
    // Missing pass definition: the issue stays needs-triage and the next
    // sweep retries.
    console.error(`[autonomy] Failed to queue triage for ${action.issueRef}:`, err);
  }
}

/**
 * Apply a triage exit's fixed consequences: advisory labels, the comment
 * carrying the assessment/questions/agenda, and the removal of needs-triage
 * — the latch that takes the issue out of the pending set, ordered last so
 * any earlier failure leaves the whole step retryable on the next sweep.
 * A completed apply also consumes the stored exit (like the unparseable
 * path does): re-adding needs-triage later — say, after the reporter
 * answers the questions — must queue a fresh pass, not replay this one.
 * Returns false when the apply did not complete, so the caller suppresses
 * the paired recommendation ping.
 */
async function executeApplyTriage(
  action: Extract<Action, { type: "applyTriage" }>
): Promise<boolean> {
  // Defence in depth behind the reducer's fixed exit mapping: an applyTriage
  // action may only ever carry advisory labels. Anything else — however it
  // got here — is refused whole. Triage can never arm execution.
  const rogue = action.addLabels.filter((l) => !ADVISORY_TRIAGE_LABELS.includes(l));
  if (rogue.length > 0) {
    console.error(
      `[autonomy] Refusing applyTriage for ${action.issueRef} — ` +
        `non-advisory label(s): ${rogue.join(", ")}`
    );
    return false;
  }

  for (const label of action.addLabels) {
    if (!(await addLabelToIssue(action.issueRef, label))) return false;
  }
  if (!(await commentOnIssue(action.issueRef, action.comment))) return false;
  if (!(await removeLabelFromIssue(action.issueRef, NEEDS_TRIAGE_LABEL))) return false;

  db.update(tasks)
    .set({ triageResult: null, updatedAt: new Date() })
    .where(eq(tasks.id, action.taskId))
    .run();

  console.log(
    `[autonomy] Triage ${action.exit} applied to ${action.issueRef}` +
      (action.addLabels.length ? ` (${action.addLabels.join(", ")})` : "")
  );
  return true;
}

/**
 * The tier line for the recommendation embed (issue #200): the reducer's own
 * sentence when the ticket or triage chose one, and otherwise the configured
 * default *named*, because the operator authorizing from Discord should see
 * the tier the run will use rather than a pointer to a settings screen. It is
 * read through `resolveLane` — the same resolution the implement pass makes
 * at start, fresh, against the primary lane — rather than the model-choice
 * step alone, because the lane has the last word on an unset tier: a priced
 * lane resolves it to `standard` where Anthropic-direct lets the harness
 * choose (#175), and naming the step's answer would name a tier the run
 * does not use. A lane that cannot resolve (a missing credential) names
 * nothing: that run fails before it starts, and #172 reports why. The
 * sentence itself is the reducer's (`describeDefaultTier`), so the two
 * surfaces cannot drift apart in wording.
 */
function describeRunTierForEmbed(tier: RunTierChoice): string {
  if (tier !== null) return describeRunTier(tier);
  const catalog = getLaneCatalog();
  const resolution = catalog.ok
    ? resolveLane({
        catalog: catalog.catalog,
        kind: "implement",
        config: getConfig(),
        ticketModel: null,
        overrides: getSettingsOverrides(),
        env: process.env,
        laneId: null,
      })
    : null;
  return describeDefaultTier(resolution?.ok ? resolution.lane : null);
}

/**
 * Ping the owner that triage recommends arming — to the project's linked
 * channel, or the fleet channel when the project has none. The message id is
 * stored on the triage task so a reply of "yes" routes back as the explicit
 * confirmation the arming route requires. No channel configured is fine: the
 * assessment is on the issue and a label click arms it just the same.
 */
async function executeTriageRecommendation(payload: {
  taskId: string;
  issueRef: string;
  issueTitle: string;
  projectId: string;
  assessment: string;
  tier: RunTierChoice;
}): Promise<void> {
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, payload.projectId))
    .get();
  const channelId = project?.discordChannelId ?? getConfig().discordFleetChannelId;
  if (!channelId) {
    console.log(
      `[autonomy] Triage recommends arming ${payload.issueRef} — no Discord ` +
        `channel configured, the assessment is on the issue`
    );
    return;
  }

  const msgId = await notifyTriageRecommendation(channelId, {
    taskId: payload.taskId,
    issueRef: payload.issueRef,
    issueTitle: payload.issueTitle,
    assessment: payload.assessment,
    tierLine: describeRunTierForEmbed(payload.tier),
    projectName: project?.name ?? null,
  });
  if (msgId) {
    db.update(tasks)
      .set({ discordMessageId: msgId, updatedAt: new Date() })
      .where(eq(tasks.id, payload.taskId))
      .run();
  }
}

/**
 * An unparseable triage exit fails closed: nothing applied, needs-triage
 * kept so the issue stays visible in the tracker, and the owner told on the
 * issue — once. The announcement is marked only after the comment lands, so
 * a failed comment retries next sweep. Landing it also clears the stored
 * result: the failure is consumed, and the issue becomes a candidate again
 * for the one retry the lifetime pass bound allows — a transient failure
 * (budget blown mid-pass, container death) gets a second look, a persistent
 * one ends parked on the label, never in a spend loop.
 */
async function executeTriageUnparseable(payload: {
  taskId: string;
  issueRef: string;
  reason: string;
}): Promise<void> {
  console.error(
    `[autonomy] Triage pass for ${payload.issueRef} returned no usable exit: ${payload.reason}`
  );
  const commented = await commentOnIssue(
    payload.issueRef,
    `The triage pass did not return a parseable exit (${payload.reason}). ` +
      `Failing closed — nothing applied; \`${NEEDS_TRIAGE_LABEL}\` stays. Triage ` +
      `retries a failed pass once; if this message reappears, route the issue by hand.`
  );
  if (!commented) return;
  announcedTriageErrors.add(payload.taskId);
  db.update(tasks)
    .set({ triageResult: null, updatedAt: new Date() })
    .where(eq(tasks.id, payload.taskId))
    .run();
}

/**
 * Arm an issue on the owner's explicit Discord confirmation of a triage
 * recommendation. This is deliberately NOT reachable from decideNext or any
 * pass output — the reducer's action vocabulary cannot express it. It runs
 * only from the Discord reply handler, carrying a human's yes, which is the
 * one thing the security model lets arming trace to. The route is recorded
 * on the issue before the label lands: a record without arming retries; an
 * arming without a record would be an audit gap.
 */
export async function armIssueFromDiscord(
  issueRef: string,
  confirmedBy: string
): Promise<boolean> {
  const ref = parseIssueRef(issueRef);
  if (!ref) return false;

  try {
    const octokit = await getOctokit();
    const { data: issue } = await octokit.rest.issues.get({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.number,
    });
    if (issue.state !== "open") return false;
    if (labelNames(issue.labels).includes(ARMING_LABEL)) return true; // already armed

    const recorded = await commentOnIssue(
      issueRef,
      `Armed via Discord: ${confirmedBy} confirmed the triage recommendation — ` +
        `applying \`${ARMING_LABEL}\`.`
    );
    if (!recorded) return false;
    if (!(await addLabelToIssue(issueRef, ARMING_LABEL))) return false;

    console.log(`[autonomy] ${issueRef} armed via Discord confirmation by ${confirmedBy}`);
    runAutonomySweep().catch((err) =>
      console.error("[autonomy] Post-arming sweep failed:", err)
    );
    return true;
  } catch (err) {
    console.error(`[autonomy] Discord arming of ${issueRef} failed:`, err);
    return false;
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
      .set({
        reviewVerdict: "approve",
        reviewResult: null,
        reviewedHeadSha: action.headSha,
      })
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
        reviewedHeadSha: action.headSha,
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
      .set({
        reviewVerdict: "escalate",
        reviewResult: null,
        reviewedHeadSha: action.headSha,
        status: "gated",
      })
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
  // The PR is settled, so an owed review is moot: cancel any pass still queued
  // (or running) under this now-terminal run so it cannot wedge pickup (#124).
  await terminalizeFinalizedRunTasks(action.runId);

  console.log(`[autonomy] Run ${action.runId} settled: ${action.issueRef} ${action.outcome}`);
}

/**
 * Queue a repair pass for a parked run and hand the run over to it — the shape
 * both repair kinds share: the merge-conflict repair (issue #54) and the CI
 * repair (issue #130). Returns the new task's id, or null when the action was
 * stale (only a parked run still awaiting its merge is repaired), so the caller
 * can skip its logging and issue comment.
 *
 * The task is inserted first: it is the idempotency anchor (a queued/running
 * repair task keeps the next sweep from double-queuing) and startTask flips the
 * run to `implementing` when it begins, so even if the run update never lands the
 * repair still runs and recovers the state. The PR is carried on the task so the
 * pass pushes to the existing PR (no second draft) and parks awaiting review
 * rather than completing outright. The run then leaves the reviewable set so the
 * review pipeline does not also act on it, with its review state cleared because
 * the push re-runs gate evaluation and review. `counted` is the repair's own
 * bound — never an attempt.
 */
async function queueRepairPass(args: {
  runId: string;
  /** "owner/repo#n" */
  issueRef: string;
  issueNumber: number;
  title: (prNumber: number) => string;
  prompt: (run: typeof runs.$inferSelect) => string;
  /** Why the parked container is being let go, shown on the task */
  releaseNote: string;
  /** The repair counter this pass spends (integrationCount or ciRepairCount) */
  counted: (run: typeof runs.$inferSelect) => Partial<typeof runs.$inferInsert>;
}): Promise<{ taskId: string; prNumber: number } | null> {
  const run = db.select().from(runs).where(eq(runs.id, args.runId)).get();
  // A stale action: only a parked run still awaiting its merge is repaired.
  if (!run || (run.status !== "reviewing" && run.status !== "gated")) return null;
  if (run.pullRequestNumber == null) return null;

  // The repair runs in a fresh container; release any container still parked
  // on this run (a reviewing run's implement pass) so nothing double-books.
  await releaseImplementContainer(args.runId, args.releaseNote);

  const now = new Date();
  const taskId = newId();
  db.insert(tasks)
    .values({
      id: taskId,
      projectId: run.projectId,
      title: args.title(run.pullRequestNumber),
      description: args.prompt(run),
      status: "queued",
      kind: "repair",
      runId: run.id,
      githubIssue: args.issueRef,
      branch: `agent/issue-${args.issueNumber}`,
      pullRequestNumber: run.pullRequestNumber,
      pullRequestUrl: run.pullRequestUrl,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  db.update(runs)
    .set({
      status: "implementing",
      ...args.counted(run),
      reviewVerdict: null,
      reviewResult: null,
      reviewedHeadSha: null,
      gateCategories: [],
    })
    .where(eq(runs.id, args.runId))
    .run();

  return { taskId, prNumber: run.pullRequestNumber };
}

/**
 * A CONFLICTING parked PR (issue #54): queue an integration-repair pass in a
 * fresh container and move the run back to `implementing` so the normal gate
 * evaluation and review pass re-run once the repair pushes. The repair counts
 * against the integration bound, never an attempt. Idempotency is the run's
 * status flip: once it is `implementing` it leaves the reviewable set, so no
 * second repair is queued while this one runs.
 */
async function executeRepairPr(action: Extract<Action, { type: "repairPr" }>): Promise<void> {
  const ref = parseIssueRef(action.issueRef);
  if (!ref) return;

  // The default branch to merge in. A read failure skips this sweep with no
  // mutation; the PR is still CONFLICTING next sweep and the repair retries.
  let baseBranch: string;
  try {
    const octokit = await getOctokit();
    const { data: repo } = await octokit.rest.repos.get({
      owner: ref.owner,
      repo: ref.repo,
    });
    baseBranch = repo.default_branch;
  } catch (err) {
    console.error(`[autonomy] Could not prepare repair for ${action.issueRef}:`, err);
    return;
  }

  const queued = await queueRepairPass({
    runId: action.runId,
    issueRef: action.issueRef,
    issueNumber: ref.number,
    title: (prNumber) => `Integration repair — PR #${prNumber}`,
    prompt: (run) =>
      buildRepairPrompt({
        repo: `${ref.owner}/${ref.repo}`,
        issueNumber: ref.number,
        prNumber: run.pullRequestNumber!,
        baseBranch,
      }),
    releaseNote: "Repairing a merge conflict in a fresh container.",
    counted: (run) => ({ integrationCount: run.integrationCount + 1 }),
  });
  if (!queued) return;

  console.log(
    `[autonomy] Repair ${action.integration} for ${action.issueRef} PR #${queued.prNumber} -> task ${queued.taskId}`
  );
  await commentOnIssue(
    action.issueRef,
    `PR #${queued.prNumber} conflicts with the default branch — starting an ` +
      `integration repair (merge \`${baseBranch}\` in, no rebase or force-push). ` +
      `Gate evaluation and review re-run on the push.`
  );
}

/**
 * A PR still CONFLICTING after its repairs are spent (issue #54): hand it to a
 * human. Disarm (if armed), label it `human-signoff`, land the run in `gated`
 * and release its container. The run's spent integrationCount is what the
 * dashboard reads as the distinct conflict needs-you entry — this is a visible
 * stall, not silence. Mutations run before the announcement, so a failure
 * leaves it un-announced and the next sweep retries the whole step.
 */
async function executeEscalateConflict(
  action: Extract<Action, { type: "escalateConflict" }>
): Promise<void> {
  const ref = parseIssueRef(action.issueRef);
  if (!ref) return;

  if (action.armed) {
    const disarmed = await disarmAutoMerge(ref.owner, ref.repo, action.prNumber);
    if (!disarmed) return;
  }
  const labeled = await labelPr(ref.owner, ref.repo, action.prNumber, HUMAN_SIGNOFF_LABEL);
  if (!labeled) return;

  db.update(runs)
    .set({ status: "gated", reviewResult: null })
    .where(eq(runs.id, action.runId))
    .run();
  await releaseImplementContainer(
    action.runId,
    "Merge conflict needs a human — releasing container."
  );

  announcedIntegrationEscalations.add(action.runId);
  const repairs = `${action.integrationsMade} automated repair${
    action.integrationsMade === 1 ? "" : "s"
  }`;
  console.error(
    `[autonomy] Integration repair exhausted for ${action.issueRef} PR #${action.prNumber} — needs a human`
  );
  await commentOnIssue(
    action.issueRef,
    `PR #${action.prNumber} still conflicts with the default branch after ${repairs}. ` +
      `Auto-merge is disarmed and it is labelled \`${HUMAN_SIGNOFF_LABEL}\` — please resolve ` +
      `the conflict and merge this one.`
  );
  await notifyIntegrationEscalation(getConfig().discordFleetChannelId, {
    issueRef: action.issueRef,
    prNumber: action.prNumber,
    integrationsMade: action.integrationsMade,
  });
}

/**
 * A repaired PR that is mergeable again: close out the conflict episode by
 * resetting the run's integration counter, so a later, unrelated conflict is
 * judged on its own repairs rather than a stale count.
 */
function executeClearIntegration(
  action: Extract<Action, { type: "clearIntegration" }>
): void {
  db.update(runs)
    .set({ integrationCount: 0 })
    .where(eq(runs.id, action.runId))
    .run();
  announcedIntegrationEscalations.delete(action.runId);
  console.log(`[autonomy] ${action.issueRef} is mergeable again — integration counter reset`);
}

/**
 * A parked PR whose checks are red (issue #130): queue a CI-repair pass in a
 * fresh container and move the run back to `implementing` so gate evaluation and
 * review re-run once the repair pushes. Mirrors executeRepairPr — the same task
 * kind (`repair`, so it inherits the modest repair budget and the turn manager's
 * implement-shaped handling), the same idempotency (the status flip takes the run
 * out of the reviewable set), the same freedom from attempt accounting — but it
 * counts against ciRepairCount, its own bound. Runs whether or not auto-merge is
 * armed: a gated PR with red checks is equally stuck, and the human still owns
 * the merge.
 */
async function executeRepairChecks(
  action: Extract<Action, { type: "repairChecks" }>
): Promise<void> {
  const ref = parseIssueRef(action.issueRef);
  if (!ref) return;

  const queued = await queueRepairPass({
    runId: action.runId,
    issueRef: action.issueRef,
    issueNumber: ref.number,
    title: (prNumber) => `CI repair — PR #${prNumber}`,
    prompt: (run) =>
      buildCiRepairPrompt({
        repo: `${ref.owner}/${ref.repo}`,
        issueNumber: ref.number,
        prNumber: run.pullRequestNumber!,
        headSha: action.headSha,
        failedChecks: action.failedChecks,
      }),
    releaseNote: "Repairing failing checks in a fresh container.",
    counted: (run) => ({ ciRepairCount: run.ciRepairCount + 1 }),
  });
  if (!queued) return;

  const names = checkNames(action.failedChecks);
  // The confirmation is named in the log: the settled choice (2026-08-12) is to
  // confirm a red rollup over consecutive sweeps rather than re-run the failed
  // check, so the record says which guard let this repair through.
  console.log(
    `[autonomy] CI repair ${action.ciRepair} for ${action.issueRef} PR #${queued.prNumber} ` +
      `(${names}) after ${CHECK_FAILURE_CONFIRMATION_SWEEPS} failing sweeps, no check re-runs ` +
      `-> task ${queued.taskId}`
  );
  await commentOnIssue(
    action.issueRef,
    `PR #${queued.prNumber} merges cleanly but its checks are failing at ` +
      `\`${shortSha(action.headSha)}\` (${names}) — starting a CI repair pass. ` +
      `Gate evaluation and review re-run on the push.`
  );
}

/**
 * A PR whose checks are still red after its CI repairs are spent (issue #130):
 * hand it to a human. Disarm (if armed), label the PR `human-signoff`, land the
 * run in `gated`, release its container, and swap the issue's `ready-for-agent`
 * for `ready-for-human` so the tracker queue shows it too — the loop has given
 * up on this red build, and the ticket must not read as still-in-progress.
 * Mutations run before the announcement, so a failure leaves it un-announced and
 * the next sweep retries the whole step.
 */
async function executeEscalateChecks(
  action: Extract<Action, { type: "escalateChecks" }>
): Promise<void> {
  const ref = parseIssueRef(action.issueRef);
  if (!ref) return;

  if (action.armed) {
    const disarmed = await disarmAutoMerge(ref.owner, ref.repo, action.prNumber);
    if (!disarmed) return;
  }
  const labeled = await labelPr(ref.owner, ref.repo, action.prNumber, HUMAN_SIGNOFF_LABEL);
  if (!labeled) return;
  // Ready-for-human added before ready-for-agent is removed, so the issue is
  // never in neither queue (the same ordering as exhaustion).
  if (!(await addLabelToIssue(action.issueRef, READY_FOR_HUMAN_LABEL))) return;
  if (!(await removeLabelFromIssue(action.issueRef, ARMING_LABEL))) return;

  db.update(runs)
    .set({ status: "gated", reviewResult: null })
    .where(eq(runs.id, action.runId))
    .run();
  await releaseImplementContainer(
    action.runId,
    "Failing checks need a human — releasing container."
  );

  announcedCheckEscalations.add(action.runId);
  const repairs =
    action.ciRepairsMade === 1
      ? "an automated repair"
      : `${action.ciRepairsMade} automated repairs`;
  const names = checkNames(action.failedChecks);
  console.error(
    `[autonomy] CI repair exhausted for ${action.issueRef} PR #${action.prNumber} ` +
      `(${names}) — needs a human`
  );
  await commentOnIssue(
    action.issueRef,
    `PR #${action.prNumber} still has failing checks after ${repairs}: ${names}. ` +
      `Auto-merge is disarmed, the PR is labelled \`${HUMAN_SIGNOFF_LABEL}\` and the ` +
      `ticket is back to \`${READY_FOR_HUMAN_LABEL}\` — please take this one.`
  );
  await notifyChecksEscalation(getConfig().discordFleetChannelId, {
    issueRef: action.issueRef,
    prNumber: action.prNumber,
    ciRepairsMade: action.ciRepairsMade,
    failedChecks: action.failedChecks.map((check) => check.name),
  });
}

/**
 * A repaired PR whose rollup is green again: close out the episode by resetting
 * the run's CI-repair counter, so a later, unrelated failure is judged on its
 * own repairs rather than a stale count.
 */
function executeClearCiRepair(
  action: Extract<Action, { type: "clearCiRepair" }>
): void {
  db.update(runs)
    .set({ ciRepairCount: 0 })
    .where(eq(runs.id, action.runId))
    .run();
  announcedCheckEscalations.delete(action.runId);
  console.log(`[autonomy] ${action.issueRef} checks are green again — CI repair counter reset`);
}

/** A commit for prose: the short SHA humans read on GitHub. */
function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Why the reviewer's own review is being withdrawn — the message GitHub shows
 * against the dismissal, so the PR itself explains what happened. */
function dismissalMessage(reviewedHeadSha: string, headSha: string): string {
  return (
    `Dismissed automatically: this review was written about ${shortSha(reviewedHeadSha)}, ` +
    `and the pull request's head has since moved to ${shortSha(headSha)}. ` +
    `It is not evidence about the code that is on the branch now.`
  );
}

/**
 * The reviewed commit moved (issue #131): a human clicked *Update branch*,
 * pushed a commit, or merged the default branch in after the verdict was
 * posted, so the standing approval describes code nobody reviewed.
 *
 * Ordering is the safety property. Disarm first — an armed run must never
 * auto-merge a head no one has read — then withdraw the standing review, and
 * only then hand the run back to gate evaluation, exactly as a repair push
 * does: the next sweep re-gates against the new diff and queues one fresh
 * review pass. The dismissal is not optional politeness — GitHub keeps counting
 * an approval until it is dismissed, so re-arming auto-merge over one would
 * land the unreviewed head — and a refusal is remembered rather than acted on
 * here: the reducer sees it on the next sweep and routes the run to a human,
 * which keeps the escalation decision where every other one lives.
 */
async function executeInvalidateReview(
  action: Extract<Action, { type: "invalidateReview" }>
): Promise<void> {
  const ref = parseIssueRef(action.issueRef);
  if (!ref) return;

  // A stale action: only a parked run still awaiting its merge is invalidated.
  const run = db.select().from(runs).where(eq(runs.id, action.runId)).get();
  if (!run || (run.status !== "reviewing" && run.status !== "gated")) return;

  if (action.armed) {
    const disarmed = await disarmAutoMerge(ref.owner, ref.repo, action.prNumber);
    if (!disarmed) return;
  }

  const dismissed = await dismissStaleReviewsAsReviewer(
    ref.owner,
    ref.repo,
    action.prNumber,
    action.headSha,
    dismissalMessage(action.reviewedHeadSha, action.headSha)
  );
  if (dismissed === null) {
    // Nothing is mutated: auto-merge is off, the verdict stands as the record,
    // and the next sweep's snapshot carries the refusal to the reducer.
    staleDismissalFailures.add(action.runId);
    console.error(
      `[autonomy] Could not withdraw the stale review on ${action.issueRef} ` +
        `PR #${action.prNumber} — leaving it to a human rather than re-arming over it`
    );
    return;
  }
  staleDismissalFailures.delete(action.runId);

  db.update(runs)
    .set({
      status: "implementing",
      reviewVerdict: null,
      reviewResult: null,
      reviewedHeadSha: null,
      gateCategories: [],
      reviewCycleCount: run.reviewCycleCount + 1,
    })
    .where(eq(runs.id, action.runId))
    .run();

  console.log(
    `[autonomy] ${action.issueRef} PR #${action.prNumber} moved past its reviewed head ` +
      `(${shortSha(action.reviewedHeadSha)} -> ${shortSha(action.headSha)}) — ` +
      `${dismissed} review(s) dismissed, re-gating and re-reviewing (cycle ${action.cycle})`
  );
  await commentOnIssue(
    action.issueRef,
    `PR #${action.prNumber} has moved past the commit its review was written about ` +
      `(\`${shortSha(action.reviewedHeadSha)}\` → \`${shortSha(action.headSha)}\`), so that ` +
      `verdict is no longer about the code on the branch. Auto-merge is disarmed` +
      (dismissed > 0 ? `, the stale review is dismissed` : ``) +
      `, and gate evaluation plus a fresh review pass re-run against the new head ` +
      `(review cycle ${action.cycle} of ${MAX_REVIEW_CYCLES_PER_ATTEMPT}).`
  );
}

/**
 * A moved-past PR the loop will not re-review (issue #131) — its attempt has no
 * review cycle left, or the standing review could not be withdrawn and must not
 * be re-armed over. Same shape as the conflict and failing-checks escalations:
 * disarm, label `human-signoff`, land the run in `gated`, release its container,
 * say so on the issue and in Discord. The posted verdict is kept as the record
 * of what the loop said (and is what holds the run out of the review pipeline),
 * while the reviewed SHA is cleared so the hand-over is a durable one-shot: a
 * further push by the human who now owns the PR must not re-announce.
 * Mutations run before the announcement, so a failure leaves it un-announced
 * and the next sweep retries the whole step.
 */
async function executeEscalateStaleReview(
  action: Extract<Action, { type: "escalateStaleReview" }>
): Promise<void> {
  const ref = parseIssueRef(action.issueRef);
  if (!ref) return;

  if (action.armed) {
    const disarmed = await disarmAutoMerge(ref.owner, ref.repo, action.prNumber);
    if (!disarmed) return;
  }
  const labeled = await labelPr(ref.owner, ref.repo, action.prNumber, HUMAN_SIGNOFF_LABEL);
  if (!labeled) return;

  // Best-effort here, unlike the re-review path: nothing will be re-armed, so a
  // review that cannot be withdrawn misinforms but can no longer merge anything.
  // Skipped outright when a refused withdrawal is why we are here.
  const withdrawn =
    action.reason === "dismissal-failed"
      ? null
      : await dismissStaleReviewsAsReviewer(
          ref.owner,
          ref.repo,
          action.prNumber,
          action.headSha,
          dismissalMessage(action.reviewedHeadSha, action.headSha)
        );

  db.update(runs)
    .set({ status: "gated", reviewResult: null, reviewedHeadSha: null })
    .where(eq(runs.id, action.runId))
    .run();
  staleDismissalFailures.delete(action.runId);
  await releaseImplementContainer(
    action.runId,
    "The reviewed commit moved and a human owns this one — releasing container."
  );

  const cycles = `${action.reviewCycleCount} of ${MAX_REVIEW_CYCLES_PER_ATTEMPT} review cycles`;
  const why =
    action.reason === "dismissal-failed"
      ? `the standing review could not be withdrawn, so the loop will not re-arm over it`
      : `this attempt has spent ${cycles}, so the loop will not re-review it again`;
  const standing =
    withdrawn === null
      ? `The stale review is still standing on the PR` +
        (action.reason === "dismissal-failed"
          ? ` — GitHub only lets an administrator (or an account on the branch's ` +
            `dismissal allow-list) dismiss a review on a protected branch. Either ` +
            `grant the reviewer account that, or turn on *Dismiss stale pull request ` +
            `approvals when new commits are pushed* and GitHub will do it itself.`
          : `.`)
      : withdrawn > 0
        ? `The stale review has been dismissed.`
        : `No standing review was left to dismiss.`;

  console.error(
    `[autonomy] ${action.issueRef} PR #${action.prNumber} moved past its reviewed head ` +
      `(${shortSha(action.reviewedHeadSha)} -> ${shortSha(action.headSha)}) — needs a human: ${why}`
  );
  await commentOnIssue(
    action.issueRef,
    `PR #${action.prNumber} has moved past the commit its review was written about ` +
      `(\`${shortSha(action.reviewedHeadSha)}\` → \`${shortSha(action.headSha)}\`) and ` +
      `${why}. Auto-merge is disarmed and the PR is labelled \`${HUMAN_SIGNOFF_LABEL}\` — ` +
      `nothing on it has been reviewed at its current head, so please review and merge ` +
      `this one.\n\n${standing}`
  );
  await notifyStaleReviewEscalation(getConfig().discordFleetChannelId, {
    issueRef: action.issueRef,
    prNumber: action.prNumber,
    reviewedHeadSha: shortSha(action.reviewedHeadSha),
    headSha: shortSha(action.headSha),
    detail: why,
    reviewWithdrawn: withdrawn !== null && withdrawn > 0,
  });
}

/**
 * A burnt ticket goes back to a human: three failed attempts, or the
 * interruption bound (a ticket whose runs keep dying to restarts must not
 * re-claim forever on the no-attempt-consumed exemption). Labels first —
 * `ready-for-human` added before `ready-for-agent` is removed, so the issue
 * is never in neither queue, and the removal (which takes the issue out of
 * the candidate set) is what makes this fire once. Each bound at its limit
 * turns its last strike's run `exhausted`: the dashboard's needs-you bucket
 * reads it, and a deliberate re-arm then finds one fewer strike on every
 * counter — two failed runs, or four interruptions — granting exactly one
 * fresh claim instead of insta-exhausting.
 */
/**
 * Resume a run parked on the quota clock (issue #169).
 *
 * A fresh task for the same run, on the same branch, carrying the paused
 * pass's own prompt behind a resume preamble — and, when the transcript
 * survived the teardown, the session id that makes the harness continue the
 * same conversation instead of re-orienting from scratch. The queue starts it
 * under the ordinary capacity check like any other queued pass, and
 * `startTask` provisions the container: nothing here touches Docker.
 *
 * Two pieces of bookkeeping, and what is *not* touched matters as much:
 *
 * - `resumeCount` is bumped here, at the moment the resume is decided, rather
 *   than when the pass starts. A resume whose task never starts (a lane
 *   misconfiguration, a container that will not build) would otherwise be
 *   retried every sweep forever; counted here, the bound catches it.
 * - The new row records the pass it resumed (`resumedFromTaskId`), which is
 *   what carries the attempt's budget across the pause: what this pass may
 *   spend is the allowance its predecessors started on, less what they spent.
 * - The run stays `rate_limited` until its pass actually starts, and keeps its
 *   `resumeAfter`. A restart in between then leaves a run that is still
 *   visibly paused rather than one pretending to be claimed, and the
 *   dashboard's countdown keeps naming the window it waited on. `startTask`
 *   moves it to `implementing` and clears the clock, as it does for every
 *   implement-shaped pass.
 *
 * A run whose status has moved on since the decision (a human cancelled it) is
 * left alone: the action is stale, not wrong.
 */
async function executeResumeRun(
  action: Extract<Action, { type: "resumeRun" }>
): Promise<void> {
  const run = db.select().from(runs).where(eq(runs.id, action.runId)).get();
  if (!run || run.status !== "rate_limited") return;

  // Re-read the idempotency fact the decision was made on. The run stays
  // `rate_limited` while its resume is queued, so status alone cannot say
  // whether one is already under way — and two sweeps can be in flight at once
  // (a webhook-triggered one runs on the app router's module graph, issue
  // #159), which would otherwise mean two containers for one run.
  const alreadyResuming = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.runId, run.id), inArray(tasks.status, ["queued", "running"])))
    .all();
  if (alreadyResuming.length > 0) return;

  // The pass that was paused — its prompt, its kind and its session. The run's
  // most recent work-carrying task: a repair pass can be walled exactly as an
  // implement pass can, and resuming it as an implement pass would hand a
  // conflict-repair brief to something that thinks it is building a feature.
  const paused = db
    .select()
    .from(tasks)
    .where(eq(tasks.runId, run.id))
    .all()
    .filter((task) => task.kind === "implement" || task.kind === "repair")
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .pop();
  if (!paused) {
    console.error(
      `[autonomy] Run ${action.runId} is paused but owns no implement pass to resume`
    );
    return;
  }

  // The session is only worth resuming if its transcript is actually on disk:
  // `--resume` against a session the fresh container has never heard of would
  // fail the pass outright, where the declared fallback is a pass that starts
  // again on the same branch with its context lost.
  const sessionId =
    paused.sessionId !== null && hasTranscript(run.id) ? paused.sessionId : null;

  const now = new Date();
  const taskId = newId();
  db.insert(tasks)
    .values({
      id: taskId,
      projectId: run.projectId,
      title: paused.title,
      description: buildResumePrompt({
        originalPrompt: paused.description,
        branch: paused.branch ?? "the attempt's branch",
        resume: action.resume,
        maxResumes: action.maxResumes,
      }),
      status: "queued",
      kind: paused.kind,
      runId: run.id,
      githubIssue: action.issueRef,
      branch: paused.branch,
      sessionId,
      // Lineage, and with it the attempt's budget: a resume is a new row, so
      // without this the turn manager would hand the attempt its whole
      // per-attempt allowance again, once per resume (issue #169).
      resumedFromTaskId: paused.id,
      pullRequestNumber: paused.pullRequestNumber,
      pullRequestUrl: paused.pullRequestUrl,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  db.update(runs)
    .set({ resumeCount: run.resumeCount + 1 })
    .where(eq(runs.id, run.id))
    .run();

  console.log(
    `[autonomy] Resuming ${action.issueRef} (attempt ${run.attempt}, resume ` +
      `${action.resume}/${action.maxResumes}) -> task ${taskId}` +
      `${sessionId ? ` continuing session ${sessionId}` : " without its prior context"}`
  );

  await commentOnIssue(
    action.issueRef,
    `The quota window has reset — resuming attempt ${run.attempt} ` +
      `(resume ${action.resume}/${action.maxResumes}). ` +
      (sessionId
        ? `The paused pass's session was preserved, so it continues the same ` +
          `conversation on \`${paused.branch}\`.`
        : `The paused pass's session could not be preserved, so it starts again ` +
          `on \`${paused.branch}\` with the work pushed so far and no prior ` +
          `context.`)
  );
}

/**
 * A run that has paused more often than one attempt may (issue #169): hand the
 * ticket to a human the way an exhausted one is handed over.
 *
 * The run lands in `exhausted` rather than `failed`, deliberately. Attempts are
 * counted from *failed* runs, and the pauses spent none — so a human who reads
 * the story and re-arms the ticket gets the attempts it never used, while the
 * run still leaves the active set so nothing claims a second one over it.
 *
 * Labels first, and the mutation only if they landed: a run driven terminal
 * whose issue still says `ready-for-agent` would be re-claimed as if nothing
 * had happened.
 */
async function executeExhaustPausedRun(
  action: Extract<Action, { type: "exhaustPausedRun" }>
): Promise<void> {
  const run = db.select().from(runs).where(eq(runs.id, action.runId)).get();
  if (!run || run.status !== "rate_limited") return;

  if (!(await addLabelToIssue(action.issueRef, READY_FOR_HUMAN_LABEL))) return;
  if (!(await removeLabelFromIssue(action.issueRef, ARMING_LABEL))) return;

  const spent =
    action.resumesMade === 0
      ? "resuming after a quota pause is switched off"
      : `it was resumed ${action.resumesMade} time(s) and walled again each time`;

  db.update(runs)
    .set({
      status: "exhausted",
      finishedAt: new Date(),
      resumeAfter: null,
      failureReason: `the account's quota kept refusing this attempt — ${spent}`,
    })
    .where(eq(runs.id, run.id))
    .run();
  await terminalizeFinalizedRunTasks(run.id);
  // Nothing will resume this conversation now.
  discardTranscript(run.id);

  console.log(
    `[autonomy] ${action.issueRef} hit the quota resume bound ` +
      `(${action.resumesMade}) — ready-for-human`
  );

  const allRuns = db
    .select()
    .from(runs)
    .where(eq(runs.githubIssue, action.issueRef))
    .all();
  const totalSpendUsd = allRuns.reduce((sum, r) => sum + r.totalCostUsd, 0);

  await commentOnIssue(
    action.issueRef,
    `This attempt kept hitting the account's quota: ${spent}. Swapping ` +
      `\`${ARMING_LABEL}\` for \`${READY_FOR_HUMAN_LABEL}\`.\n\n` +
      `A quota pause spends no attempt, so attempt ${run.attempt} is still ` +
      `this ticket's — re-arming it once there is quota picks the work back up ` +
      `on \`agent/issue-${parseIssueRef(action.issueRef)?.number ?? "?"}\`, ` +
      `where everything pushed so far already lives.\n\n` +
      `Total autonomous spend on this ticket: $${totalSpendUsd.toFixed(2)}.`
  );

  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, run.projectId))
    .get();
  await notifyAttemptsExhausted(
    project?.discordChannelId ?? getConfig().discordFleetChannelId,
    {
      issueRef: action.issueRef,
      attempts: run.attempt,
      interruptions: run.interruptionCount,
      resumes: action.resumesMade,
      reason: "quota-pauses",
      totalSpendUsd,
    }
  );
}

async function executeExhaust(action: Extract<Action, { type: "exhaust" }>): Promise<void> {
  if (!(await addLabelToIssue(action.issueRef, READY_FOR_HUMAN_LABEL))) return;
  if (!(await removeLabelFromIssue(action.issueRef, ARMING_LABEL))) return;

  const allRuns = db
    .select()
    .from(runs)
    .where(eq(runs.githubIssue, action.issueRef))
    .all()
    .sort((a, b) => a.claimedAt.getTime() - b.claimedAt.getTime());
  const failed = allRuns.filter((r) => r.status === "failed");
  const interrupted = allRuns.filter((r) => r.status === "interrupted");

  // Every bound at its limit surrenders one strike to the exhausted marker —
  // usually just the one that fired, but a double-burnt ticket marks both, or
  // a single re-arm would insta-exhaust on the other counter instead of
  // getting its one fresh claim.
  const strikes = action.reason === "interruptions" ? interrupted : failed;
  const last = strikes[strikes.length - 1];
  const markers = [
    ...(action.attemptsMade >= MAX_ATTEMPTS ? [failed[failed.length - 1]] : []),
    ...(action.interruptionsMade >= MAX_INTERRUPTIONS_PER_TICKET
      ? [interrupted[interrupted.length - 1]]
      : []),
  ].filter((r) => r != null);
  for (const marker of markers) {
    db.update(runs).set({ status: "exhausted" }).where(eq(runs.id, marker.id)).run();
    // Defence-in-depth: a marked run was already failed/interrupted, so its
    // tasks are terminal — but keep the "no task outlives its run" invariant
    // total even here (issue #124).
    await terminalizeFinalizedRunTasks(marker.id);
  }

  // The strikes are the failed (or interrupted) runs, but the ticket's bill
  // is every run it ever had — interrupted and cancelled ones, and a prior
  // exhausted run from before a human re-arm, still spent real money.
  const totalSpendUsd = allRuns.reduce((sum, r) => sum + r.totalCostUsd, 0);
  const attemptLines = failed.map(
    (r) =>
      `- attempt ${r.attempt}: $${r.totalCostUsd.toFixed(2)} — ${r.failureReason ?? "failed"}`
  );

  if (action.reason === "interruptions") {
    console.log(
      `[autonomy] ${action.issueRef} hit the interruption bound ` +
        `(${action.interruptionsMade}) — ready-for-human`
    );
    await commentOnIssue(
      action.issueRef,
      `${action.interruptionsMade} runs on this ticket were lost to interruptions ` +
        `— an orchestrator restart, or a container that died before finishing ` +
        `(OOM / docker error). Interruptions never consume attempts, but re-claims ` +
        `are bounded — swapping \`${ARMING_LABEL}\` for \`${READY_FOR_HUMAN_LABEL}\`.\n\n` +
        (attemptLines.length > 0 ? `Failed attempts so far:\n${attemptLines.join("\n")}\n\n` : "") +
        `Total autonomous spend on this ticket: $${totalSpendUsd.toFixed(2)}.`
    );
  } else {
    console.log(
      `[autonomy] ${action.issueRef} exhausted after ${action.attemptsMade} attempts — ready-for-human`
    );
    await commentOnIssue(
      action.issueRef,
      `All ${action.attemptsMade} autonomous attempts failed — swapping ` +
        `\`${ARMING_LABEL}\` for \`${READY_FOR_HUMAN_LABEL}\`.\n\n` +
        `${attemptLines.join("\n")}\n\n` +
        `Total autonomous spend on this ticket: $${totalSpendUsd.toFixed(2)}.`
    );
  }

  const project = last
    ? db.select().from(projects).where(eq(projects.id, last.projectId)).get()
    : undefined;
  await notifyAttemptsExhausted(
    project?.discordChannelId ?? getConfig().discordFleetChannelId,
    {
      issueRef: action.issueRef,
      attempts: action.attemptsMade,
      interruptions: action.interruptionsMade,
      reason: action.reason,
      totalSpendUsd,
    }
  );
}

/**
 * An attempt that exhausted its review cycles: the final request-changes
 * findings still land on the PR as the record, but no fix-up turn runs — the
 * run fails, counting a strike toward exhaustion. Ordering fails safe:
 * disarm before anything else (abort and retry next sweep if it fails), and
 * the review post is best-effort — with auto-merge off and no approval
 * posted, nothing can merge either way.
 */
async function executeFailAttempt(
  action: Extract<Action, { type: "failAttempt" }>
): Promise<void> {
  const ref = parseIssueRef(action.issueRef);
  if (!ref) return;

  if (action.armed) {
    const disarmed = await disarmAutoMerge(ref.owner, ref.repo, action.prNumber);
    if (!disarmed) return;
  }

  const posted = await postReviewAsReviewer(
    ref.owner,
    ref.repo,
    action.prNumber,
    "REQUEST_CHANGES",
    action.reviewBody
  );

  const run = db.select().from(runs).where(eq(runs.id, action.runId)).get();
  db.update(runs)
    .set({
      status: "failed",
      failureReason: "review cycles exhausted",
      reviewResult: null,
      ...(posted
        ? { reviewVerdict: "request-changes" as const, reviewedHeadSha: action.headSha }
        : {}),
      finishedAt: new Date(),
    })
    .where(eq(runs.id, action.runId))
    .run();

  await releaseImplementContainer(
    action.runId,
    "Review cycles exhausted — attempt failed, releasing container."
  );
  // Defence-in-depth: the failing verdict's review already completed, but if
  // any pass is still non-terminal under this now-failed run, cancel it (#124).
  await terminalizeFinalizedRunTasks(action.runId);

  console.log(
    `[autonomy] Run ${action.runId} failed: review cycles exhausted (${action.issueRef})`
  );
  await commentOnIssue(
    action.issueRef,
    `Run failed (attempt ${run?.attempt ?? "?"}/${MAX_ATTEMPTS}): review cycles ` +
      `exhausted — ${MAX_REVIEW_CYCLES_PER_ATTEMPT} implement↔review cycles without ` +
      `an approval. ` +
      (posted
        ? `The reviewer's final findings are on PR #${action.prNumber}.`
        : `Posting the review to PR #${action.prNumber} failed; the reviewer's ` +
          `final findings were:\n\n${action.reviewBody}`)
  );
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

/** Release a run's parked working container (implement or repair) once no
 * further turn can use it. */
async function releaseImplementContainer(runId: string, note: string): Promise<void> {
  const workingTask = workingTaskOf(runId);
  if (workingTask?.status === "running") {
    await releaseParkedImplementTask(workingTask.id, note);
  }
}

/**
 * The run-finalization cleanup (issue #124): once a run reaches a terminal
 * status, cancel any task it still owns that never terminalized and let go of
 * any container such a task held. The orphan this exists to catch is a review
 * pass left `queued` because the single slot was busy when its gated PR was
 * merged by hand — the run finalized to `merged`, but its queued review sat
 * non-terminal, read as a reserved slot, and halted all new pickup (the
 * LPS #135 incident).
 *
 * Call this *after* `releaseImplementContainer` at each finalization point:
 * that releases the parked implement/repair task to `completed`, so what
 * remains here is the genuine orphan. A queued orphan has no container; a
 * running one (a review a hand-merge raced) is removed by name, mirroring
 * `reapOrphanedReviewPasses`.
 */
async function terminalizeFinalizedRunTasks(runId: string): Promise<void> {
  const cancelled = cancelOrphanedRunTasks(db, runId);
  for (const task of cancelled) {
    getActiveTasks().delete(task.taskId);
    if (task.containerName) await removeContainerByName(task.containerName);
    console.log(
      `[autonomy] Cancelled orphaned task ${task.taskId} under finalized run ${runId} ` +
        `— a pass must not outlive its run (issue #124)`
    );
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

    // A retry starts amnesiac unless it is handed the prior attempts' failure
    // reasons and the tail of the issue's comments (issue #73). Both are
    // gathered here — the ledger and GitHub are I/O — and injected into the
    // prompt as context, never as instructions that widen authority. The first
    // attempt has no history, so we skip the reads entirely.
    let priorAttempts: PriorAttempt[] = [];
    let recentComments: Awaited<ReturnType<typeof listRecentIssueComments>> = [];
    if (action.attempt > 1) {
      priorAttempts = db
        .select()
        .from(runs)
        .where(and(eq(runs.githubIssue, action.issueRef), eq(runs.status, "failed")))
        .all()
        .sort((a, b) => a.attempt - b.attempt)
        .map((r) => ({ attempt: r.attempt, failureReason: r.failureReason }));
      recentComments = await listRecentIssueComments(action.issueRef, RETRY_COMMENT_TAIL);
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
        priorAttempts,
        recentComments,
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
        checkpoint: action.checkpoint,
        maxTurns: action.maxTurns,
        // A `model:` directive (already allowlist-clamped) pins the tier from
        // claim time (issue #80); the implement pass resolves through the same
        // value and records it here. Null keeps the configured default.
        model: action.model,
        // An `effort:` directive (already allowlist-clamped) pins the level
        // from claim time (issue #81); the implement pass resolves through the
        // same value and records it here. Null keeps the configured default.
        effort: action.effort,
        claimedAt: now,
        finishedAt: failure ? now : null,
        failureReason: failure ? `failed before start: ${failure}` : null,
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

    // Note the model directive on the run's issue thread (issue #80): the
    // honoured tier when one was picked, or an unrecognised request that was
    // ignored — never silently swallowed, never fatal. The tier is what is
    // reported, not the word the ticket used, because a legacy alias
    // (`model: opus`) resolves to one (issue #166) and the tier is what the
    // fleet acted on.
    // A tier triage suggested (issue #200) is named as such: it reached the run
    // without appearing in the body, so the claim comment is where a human
    // sees that the fleet acted on a suggestion rather than on the ticket.
    let modelNote = "";
    if (action.model && action.modelSource) {
      modelNote = `\n\nModel tier: \`${action.model}\` (${describeTierSource(action.modelSource)}).`;
    }
    if (action.modelSource !== "ticket") {
      const rawModel = rawModelDirective(action.issueBody);
      if (rawModel) {
        console.warn(
          `[autonomy] Ignoring unrecognised model directive "${rawModel}" on ` +
            `${action.issueRef} — ` +
            (action.model ? `using triage's suggested tier` : `using the default model`)
        );
        modelNote +=
          `\n\nModel directive \`${rawModel}\` not recognised — ` +
          (action.model
            ? `triage's suggestion above stands in for it.`
            : `running on the default model.`);
      }
    }

    // Note the effort directive the same way (issue #81) — the honoured level,
    // or an unrecognised request that was ignored; never silently swallowed.
    let effortNote = "";
    if (action.effort) {
      effortNote = `\n\nEffort: \`${action.effort}\` (ticket directive).`;
    } else {
      const rawEffort = rawEffortDirective(action.issueBody);
      if (rawEffort) {
        console.warn(
          `[autonomy] Ignoring unrecognised effort directive "${rawEffort}" on ` +
            `${action.issueRef} — using the default effort`
        );
        effortNote = `\n\nEffort directive \`${rawEffort}\` not recognised — running at the default effort.`;
      }
    }

    const domain = process.env.DOMAIN ?? "interludes.co.uk";
    await commentOnIssue(
      action.issueRef,
      `Claimed by Interlude — attempt ${action.attempt}/${MAX_ATTEMPTS}.${modelNote}${effortNote}\n\n` +
        `[View task](https://${domain}/tasks/${taskId})`
    );
  } finally {
    inFlightClaims.delete(action.issueRef);
  }
}
