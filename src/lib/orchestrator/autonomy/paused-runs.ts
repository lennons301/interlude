/**
 * Runs parked on the quota clock (issues #169, #199): what the sweep gathers
 * about them, and how one is resumed.
 *
 * Extracted from the sweep when the paused-run path gained its second resume
 * condition, so the gatherer and the two executors can be driven over a real
 * (in-memory, migrated) database with the real `lanes.yaml` — the way
 * `lane-failover.test.ts` drives the turn manager — rather than sitting
 * private inside a module nothing can import under test.
 *
 * Two conditions resume a paused run, and they share one executor body:
 *
 *  - **its window has reset** (#169): the ordinary resume, on the run's own
 *    lane, through its jitter;
 *  - **another lane can serve it now** (#199): an early resume onto that lane.
 *    Re-decided every sweep, so a paid lane authorised a minute after the
 *    pause — the day's spend confirmed, a cap raised, a floor lifted — takes
 *    effect at the next tick rather than at the end of the window. Before
 *    this the path resumed on exactly one condition, the clock, and a run
 *    parked for five hours beside a lane costing a fortieth as much; on a
 *    one-slot box a dependency chain stalled behind it.
 *
 * The early resume is a lane move like any other (#176). It is ranked by the
 * same `readLaneFailover` a refused pass is offered at the moment of its wall,
 * with the walled lane excluded, so the two paths cannot disagree about which
 * lane is cheapest. #174's cap and confirm-once press are evaluated *inside*
 * that ranking, per lane against that lane's own cap, so a money-held lane is
 * never offered and unattended work still starts spending real money only
 * under the day's confirmation and cap. It counts against the same resume
 * bound a clock-driven resume does, carries the session where the transcript
 * survived, and is announced with the lane and what that lane costs — a
 * crossing is never silent. The target is advisory exactly as a failover's
 * is: the resumed pass re-asks the ranking when it starts (`startTask`), so
 * `runs.lane` and `tasks.lane` record where the work really ran, and a wall
 * that lifted in the intervening half-minute sends it back to the cheaper
 * lane.
 *
 * Which of the two fires — and neither, while the wall stands and no lane can
 * serve the run — is the reducer's decision (`decideNext`). This module only
 * gathers the facts it decides from and carries out what it decided.
 * Exhaustion stays in the sweep beside the other terminal executors, whose
 * labelling and finalisation helpers it shares.
 */

import { db } from "@/db";
import { runs, tasks } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import { newId } from "../../ulid";
import { commentOnIssue } from "../../github/issues";
import type { LaneBilling } from "../../lanes/lane-config";
import type { MoneyGuards } from "../../lanes/money-state";
import { readLaneFailover } from "../../lanes/overflow-state";
import { hasTranscript } from "../../quota/session-transcript";
import type { FleetSettings } from "../../settings";
import type { Action, PausedRun } from "./decide";
import { buildLaneMovePrompt, buildResumePrompt } from "./workflow";

type RunRow = typeof runs.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;

/**
 * The pass a paused run resumes: its most recent work-carrying task. A repair
 * pass can be walled exactly as an implement pass can, and resuming it as an
 * implement pass would hand a conflict-repair brief to something that thinks
 * it is building a feature.
 */
function latestWorkPass(owned: TaskRow[]): TaskRow | null {
  return (
    owned
      .filter((task) => task.kind === "implement" || task.kind === "repair")
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .pop() ?? null
  );
}

function hasLivePass(owned: TaskRow[]): boolean {
  return owned.some((task) => task.status === "queued" || task.status === "running");
}

/**
 * Runs parked on the quota clock, with the facts the reducer decides from: how
 * many resumes this attempt has spent, whether one is already under way, and
 * — since issue #199 — whether a lane other than the walled one can serve the
 * run right now.
 *
 * `hasLiveTask` is the idempotency latch and is deliberately a *task* fact
 * rather than a run-status one: the resume executor leaves the run
 * `rate_limited` until its pass actually starts, so that a restart between the
 * two leaves a paused run that is still visibly paused rather than one
 * pretending to be claimed.
 *
 * The lane option is read through the one ranking every other lane decision
 * reads (`readLaneFailover`), at the tier the run actually runs at and with
 * the paused pass's own lane excluded, and it is not read at all for a run
 * that is already resuming — that run is not up for a decision. The money
 * guards are handed in from the sweep's single read of the tick rather than
 * re-counted per run, so two paused runs on one sweep cannot be ranked against
 * two different readings of the day's cash.
 */
export function gatherPausedRuns(
  allRuns: RunRow[],
  now: Date,
  settings: FleetSettings,
  guards: MoneyGuards
): PausedRun[] {
  const paused = allRuns.filter((run) => run.status === "rate_limited");
  if (paused.length === 0) return [];

  // One query for every paused run, as the sibling gatherers do — a sweep runs
  // every 30 seconds and its cost should not scale with how walled the account
  // happens to be.
  const ownedByRun = new Map<string, TaskRow[]>();
  for (const task of db
    .select()
    .from(tasks)
    .where(
      inArray(
        tasks.runId,
        paused.map((run) => run.id)
      )
    )
    .all()) {
    if (task.runId === null) continue;
    const owned = ownedByRun.get(task.runId) ?? [];
    owned.push(task);
    ownedByRun.set(task.runId, owned);
  }

  return paused.map((run) => {
    const owned = ownedByRun.get(run.id) ?? [];
    const hasLiveTask = hasLivePass(owned);
    const pass = latestWorkPass(owned);
    return {
      runId: run.id,
      issueRef: run.githubIssue,
      resumeAfter: run.resumeAfter,
      resumesMade: run.resumeCount,
      hasLiveTask,
      laneId: pass?.lane ?? null,
      laneFailover:
        hasLiveTask || pass === null
          ? null
          : // `run.model` is the tier the run actually runs at — degraded, if
            // #170 stepped it — which is the row of each lane's price table
            // the resumed pass would be charged from.
            readLaneFailover(pass.kind, run.model, pass.lane, now, settings, guards),
    };
  });
}

/** What the two resumes say — everything else about them is the same. */
interface ResumeVoice {
  /** The resumed pass's prompt, built over the paused pass's own brief. */
  prompt: (paused: TaskRow) => string;
  /** The orchestrator log line. */
  log: (ctx: { run: RunRow; taskId: string; sessionId: string | null }) => string;
  /** The issue comment — the human's record of what happened and why. */
  comment: (ctx: { run: RunRow; paused: TaskRow; sessionId: string | null }) => string;
}

/**
 * Queue a paused run's pass again in a fresh container, on the same branch,
 * continuing the same conversation where the transcript survived the teardown
 * — the body both resumes share (issues #169, #199).
 *
 * The task row is the unit of work and the run row is the ledger, so:
 *
 * - The new row records the pass it resumed (`resumedFromTaskId`), which is
 *   what carries the attempt's budget across the pause: what this pass may
 *   spend is the allowance its predecessors started on, less what they spent.
 * - `resumeCount` is bumped **now**, when the resume is queued, not when the
 *   pass starts — a resume whose task never starts would otherwise retry every
 *   sweep forever.
 * - The run stays `rate_limited` until its pass actually starts, and keeps its
 *   `resumeAfter`. A restart in between then leaves a run that is still
 *   visibly paused rather than one pretending to be claimed, and the
 *   dashboard's countdown keeps naming the window it waited on. `startTask`
 *   moves it to `implementing` and clears the clock, as it does for every
 *   implement-shaped pass.
 * - The session is only carried if its transcript is actually on disk:
 *   `--resume` against a session the fresh container has never heard of would
 *   fail the pass outright, where the declared fallback is a pass that starts
 *   again on the same branch with its context lost.
 *
 * A run whose status has moved on since the decision (a human cancelled it) is
 * left alone: the action is stale, not wrong. A run with a pass already queued
 * or running is left alone too — two sweeps can be in flight at once (a
 * webhook-triggered one runs on the app router's module graph, issue #159),
 * which would otherwise mean two containers for one run.
 */
async function queueResumedPass(
  runId: string,
  issueRef: string,
  voice: ResumeVoice
): Promise<void> {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run || run.status !== "rate_limited") return;

  const owned = db.select().from(tasks).where(eq(tasks.runId, run.id)).all();
  if (hasLivePass(owned)) return;

  const paused = latestWorkPass(owned);
  if (!paused) {
    console.error(
      `[autonomy] Run ${runId} is paused but owns no implement pass to resume`
    );
    return;
  }

  const sessionId =
    paused.sessionId !== null && hasTranscript(run.id) ? paused.sessionId : null;

  const now = new Date();
  const taskId = newId();
  db.insert(tasks)
    .values({
      id: taskId,
      projectId: run.projectId,
      title: paused.title,
      description: voice.prompt(paused),
      status: "queued",
      kind: paused.kind,
      runId: run.id,
      githubIssue: issueRef,
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

  console.log(voice.log({ run, taskId, sessionId }));
  await commentOnIssue(issueRef, voice.comment({ run, paused, sessionId }));
}

/** How the resumed pass stands with respect to its conversation, for the
 * issue comment — both resumes say the same two things here. */
function describeSession(paused: TaskRow, sessionId: string | null): string {
  return sessionId
    ? `The paused pass's session was preserved, so it continues the same ` +
        `conversation on \`${paused.branch}\`.`
    : `The paused pass's session could not be preserved, so it starts again ` +
        `on \`${paused.branch}\` with the work pushed so far and no prior ` +
        `context.`;
}

/**
 * A paused run whose window has reset (issue #169): resume it on its own lane.
 */
export async function executeResumeRun(
  action: Extract<Action, { type: "resumeRun" }>
): Promise<void> {
  await queueResumedPass(action.runId, action.issueRef, {
    prompt: (paused) =>
      buildResumePrompt({
        originalPrompt: paused.description,
        branch: paused.branch ?? "the attempt's branch",
        resume: action.resume,
        maxResumes: action.maxResumes,
      }),
    log: ({ run, taskId, sessionId }) =>
      `[autonomy] Resuming ${action.issueRef} (attempt ${run.attempt}, resume ` +
      `${action.resume}/${action.maxResumes}) -> task ${taskId}` +
      `${sessionId ? ` continuing session ${sessionId}` : " without its prior context"}`,
    comment: ({ run, paused, sessionId }) =>
      `The quota window has reset — resuming attempt ${run.attempt} ` +
      `(resume ${action.resume}/${action.maxResumes}). ` +
      describeSession(paused, sessionId),
  });
}

/** The settings screen's own rendering of a rate, so the issue comment and
 * the routing row quote the same figure the same way. */
function usdPerMTok(rate: number): string {
  if (rate === 0) return "$0";
  return `$${rate < 0.1 ? rate.toFixed(3) : rate.toFixed(2)}`;
}

/**
 * What running on the target lane costs, in one sentence (issue #199): a
 * crossing onto a paid lane is never silent about the money. The rate is the
 * ranking's own — USD per million tokens of a typical pass, off the lane's
 * declared prices — and a metered lane declaring none is said to be exactly
 * that, rather than dressed up with a number nothing wrote down.
 */
export function describeLaneCost(
  billing: LaneBilling,
  rateUsdPerMTok: number | null
): string {
  if (billing !== "metered") {
    return "That lane runs on subscription quota, so the move costs nothing at the margin.";
  }
  const rate =
    rateUsdPerMTok === null
      ? "at a rate its lane declares no prices for (the harness's own figure is charged)"
      : `at about ${usdPerMTok(rateUsdPerMTok)} per million tokens of a typical pass`;
  return `That lane bills real money ${rate}, within today's confirmed real-money cap.`;
}

/**
 * A paused run resumed **early**, onto a lane other than the one that walled
 * it (issue #199). The same body as the clock-driven resume — the pass, the
 * lineage, the bound, the session — with the lane move's prompt in front of
 * the brief and an announcement that names the lane and what it costs.
 *
 * The prompt is the failover's (`buildLaneMovePrompt`) rather than the
 * resume's, because what the pass is about to notice is the same: it was
 * refused mid-flight and is continuing on another lane instead of waiting the
 * window out. It deliberately does not name the model or the provider — see
 * that builder — and it carries the original brief behind its preamble so it
 * stands on its own whichever way the transcript restore went.
 */
export async function executeResumeRunOnLane(
  action: Extract<Action, { type: "resumeRunOnLane" }>
): Promise<void> {
  const from = action.fromLaneId ?? "its lane";
  const resets = action.resumeAfter.toUTCString();

  await queueResumedPass(action.runId, action.issueRef, {
    prompt: (paused) =>
      buildLaneMovePrompt({
        originalPrompt: paused.description,
        branch: paused.branch ?? "the attempt's branch",
        toLaneLabel: action.toLaneLabel,
        move: action.resume,
        maxMoves: action.maxResumes,
      }),
    log: ({ run, taskId, sessionId }) =>
      `[autonomy] Resuming ${action.issueRef} early on ${action.toLaneId} ` +
      `(attempt ${run.attempt}, resume ${action.resume}/${action.maxResumes}) — ` +
      `the window on ${from} stands until ${resets} — -> task ${taskId}` +
      `${sessionId ? ` continuing session ${sessionId}` : " without its prior context"}`,
    comment: ({ run, paused, sessionId }) =>
      `Resumed early on another lane (attempt ${run.attempt}): the window on ` +
      `\`${from}\` does not reset until ${resets}, but **${action.toLaneLabel}** ` +
      `can serve this run now, so it continues there rather than waiting the ` +
      `window out (resume ${action.resume}/${action.maxResumes}). ` +
      `${describeLaneCost(action.toLaneBilling, action.toLaneRateUsdPerMTok)} ` +
      `An early lane resumption consumes neither an attempt nor an ` +
      `interruption; it counts against the same resume bound as any other. ` +
      describeSession(paused, sessionId),
  });
}
