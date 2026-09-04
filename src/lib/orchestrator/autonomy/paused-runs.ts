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
 *
 * A third way a paused run resumes lives here too, because it shares the same
 * body: the **operator's manual move** (issue #202), from the fleet card, for
 * the run the ranking would *not* move — most often because nobody has
 * confirmed the day's real-money spend — that is gating everything behind it.
 * `readManualLaneMove` says what the press would do, `moveParkedRunToLane`
 * does it; both decide through the pure `decideManualLaneMove` over the same
 * failover ranking the sweep re-reads every tick, so the card can never offer
 * a move the sweep would have refused on other grounds.
 */

import { db } from "@/db";
import { runs, tasks } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import { newId } from "../../ulid";
import { getConfig } from "../../config";
import { commentOnIssue } from "../../github/issues";
import type { LaneBilling } from "../../lanes/lane-config";
import { describeLaneCost } from "../../lanes/lane-rate";
import { readMoneyGuards, type MoneyGuards } from "../../lanes/money-state";
import {
  readLaneFailover,
  readLaneFailoverSelection,
} from "../../lanes/overflow-state";
import { hasTranscript } from "../../quota/session-transcript";
import { getFleetSettings, type FleetSettings } from "../../settings";
import { resolveResumeBound } from "../../settings-resolver";
import type { Action, PausedRun } from "./decide";
import {
  decideManualLaneMove,
  refuse,
  type ManualLaneMoveReading,
  type ManualLaneMoveResult,
} from "./lane-move";
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
 * The facts about one paused run that every reader of it decides from — the
 * sweep's gatherer and the operator's manual move (issue #202) — in one place,
 * so "read exactly as the sweep reads them" is structural rather than a claim.
 *
 * `upForDecision` is whether the lanes are worth ranking at all: a run that is
 * not parked, is already resuming, or owns no pass to resume is refused before
 * any lane is looked at, and nothing is ranked for it.
 */
function pausedRunFacts(run: RunRow, owned: TaskRow[]) {
  const pass = latestWorkPass(owned);
  const hasLiveTask = hasLivePass(owned);
  return {
    pass,
    hasLiveTask,
    upForDecision: run.status === "rate_limited" && !hasLiveTask && pass !== null,
  };
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
    const { pass, hasLiveTask, upForDecision } = pausedRunFacts(
      run,
      ownedByRun.get(run.id) ?? []
    );
    return {
      runId: run.id,
      issueRef: run.githubIssue,
      resumeAfter: run.resumeAfter,
      resumesMade: run.resumeCount,
      hasLiveTask,
      laneId: pass?.lane ?? null,
      laneFailover:
        !upForDecision || pass === null
          ? null
          : // `run.model` is the tier the run actually runs at — degraded, if
            // #170 stepped it — which is the row of each lane's price table
            // the resumed pass would be charged from.
            readLaneFailover(pass.kind, run.model, pass.lane, now, settings, guards),
    };
  });
}

/** What the two resumes say — everything else about them is the same. */
interface ResumeWording {
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
  wording: ResumeWording
): Promise<string | null> {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run || run.status !== "rate_limited") return null;

  const owned = db.select().from(tasks).where(eq(tasks.runId, run.id)).all();
  if (hasLivePass(owned)) return null;

  const paused = latestWorkPass(owned);
  if (!paused) {
    console.error(
      `[autonomy] Run ${runId} is paused but owns no implement pass to resume`
    );
    return null;
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
      description: wording.prompt(paused),
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

  console.log(wording.log({ run, taskId, sessionId }));
  await commentOnIssue(issueRef, wording.comment({ run, paused, sessionId }));
  return taskId;
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

/** Where a lane move is going and what it counts as — the pair of moves that
 * share the wording below both carry exactly this. */
interface LaneMoveTarget {
  toLaneId: string;
  toLaneLabel: string;
  toLaneBilling: LaneBilling;
  toLaneRateUsdPerMTok: number | null;
  /** Which continuation of the attempt this is, and the bound it counts
   * against. */
  resume: number;
  maxResumes: number;
}

/**
 * What every lane move of a paused run says (issues #199, #202), given who
 * decided it: the prompt is the failover's (`buildLaneMovePrompt`), because
 * what the pass is about to notice is the same whichever way it was moved —
 * it was refused mid-flight and is continuing on another lane instead of
 * waiting the window out; and the comment names the lane and what it costs in
 * the one sentence every lane move uses (`describeLaneCost`), then says the
 * target is advisory (the lane is re-chosen as the pass starts, and
 * `tasks.lane`, not the comment, records where it ran) and what the move
 * spends (no attempt, no interruption, one continuation). One builder, so the
 * sweep's move and the operator's read the same on the money — a human reading
 * the thread should not have to wonder whether the two were charged
 * differently.
 *
 * The opening is the caller's, because it is the one thing that differs: who
 * moved the run, and why now.
 */
function laneMoveWording(
  target: LaneMoveTarget,
  say: {
    /** The log line's lead, up to the arrow to the task. */
    log: (run: RunRow) => string;
    /** The comment's opening — who decided, and the wall it skips — ending on
     * the conjunction that joins it to the lane. */
    opening: (run: RunRow) => string;
  }
): ResumeWording {
  return {
    prompt: (paused) =>
      buildLaneMovePrompt({
        originalPrompt: paused.description,
        branch: paused.branch ?? "the attempt's branch",
        toLaneLabel: target.toLaneLabel,
        move: target.resume,
        maxMoves: target.maxResumes,
      }),
    log: ({ run, taskId, sessionId }) =>
      `${say.log(run)} -> task ${taskId}` +
      `${sessionId ? ` continuing session ${sessionId}` : " without its prior context"}`,
    comment: ({ run, paused, sessionId }) =>
      `${say.opening(run)} **${target.toLaneLabel}** can serve this run now, ` +
      `so it is resuming there rather than waiting the window out ` +
      `(resume ${target.resume}/${target.maxResumes}). ` +
      `${describeLaneCost(target.toLaneBilling, target.toLaneRateUsdPerMTok)} ` +
      `The lane is re-chosen as the pass starts, so a wall that lifts first ` +
      `sends it back to the cheaper one; the task records where it actually ` +
      `ran. A lane move consumes neither an attempt nor an interruption; it ` +
      `counts against the same resume bound as any other. ` +
      describeSession(paused, sessionId),
  };
}

/**
 * A paused run resumed **early**, onto a lane other than the one that walled
 * it (issue #199). The same body as the clock-driven resume — the pass, the
 * lineage, the bound, the session — with the lane move's wording
 * (`laneMoveWording`) in front of the brief and on the issue.
 *
 * The announcement says the run *is resuming* there, and says the lane is
 * re-chosen as the pass starts, because the target is advisory exactly as a
 * failover's is: `startTask` re-asks the ranking, so a wall that lifted in the
 * intervening half-minute sends the pass back to the cheaper lane, and
 * `tasks.lane` — not this comment — records where it actually ran.
 */
export async function executeResumeRunOnLane(
  action: Extract<Action, { type: "resumeRunOnLane" }>
): Promise<void> {
  const from = action.fromLaneId ?? "its lane";
  const resets = action.resumeAfter.toUTCString();

  await queueResumedPass(
    action.runId,
    action.issueRef,
    laneMoveWording(action, {
      log: (run) =>
        `[autonomy] Resuming ${action.issueRef} early on ${action.toLaneId} ` +
        `(attempt ${run.attempt}, resume ${action.resume}/${action.maxResumes}; ` +
        `the window on ${from} stands until ${resets})`,
      opening: (run) =>
        `Resumed early on another lane (attempt ${run.attempt}): the window on ` +
        `\`${from}\` does not reset until ${resets}, but`,
    })
  );
}

/**
 * What moving this run onto another lane *now* would do (issue #202), or why
 * it may not: the fleet card asks this before it offers the press, so the
 * confirmation names the lane and quotes its cost before any money is spent.
 * Null when no such run exists.
 *
 * The facts are read exactly as `gatherPausedRuns` reads them for the sweep —
 * the same pass, the same lane excluded, the same ranking at the tier the run
 * actually runs at, over one read of the settings row and one of the money
 * guards — so what the operator is offered here and what the sweep would have
 * done by itself cannot part company. The difference is only that the whole
 * ranking is kept (`readLaneFailoverSelection`), because a refusal has to say
 * which lane a press would free, or why nowhere can serve the run at all, and
 * that answer is in the losers rather than in the winner.
 */
export function readManualLaneMove(
  runId: string,
  now: Date = new Date()
): ManualLaneMoveReading | null {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run) return null;

  const { pass, hasLiveTask, upForDecision } = pausedRunFacts(
    run,
    db.select().from(tasks).where(eq(tasks.runId, run.id)).all()
  );

  // Read fresh, never the memoised config (issue #166's freshness rule): a
  // confirmation pressed on the settings screen a moment ago is the whole
  // reason an operator presses this.
  const settings = getFleetSettings();
  const bound = resolveResumeBound(getConfig(), settings.overrides).resumes;

  // The ranking is only read for a run that is up for the decision at all —
  // a run already resuming, or with no pass to resume, is refused before it,
  // exactly as the gatherer ranks nothing for one.
  const selection =
    upForDecision && pass !== null
      ? readLaneFailoverSelection(
          pass.kind,
          // `run.model` is the tier the run actually runs at — degraded, if
          // #170 stepped it — which is the row of each lane's price table the
          // resumed pass would be charged from.
          run.model,
          pass.lane,
          now,
          settings,
          readMoneyGuards(now, settings)
        )
      : null;

  return {
    runId: run.id,
    issueRef: run.githubIssue,
    decision: decideManualLaneMove({
      runStatus: run.status,
      hasLiveTask,
      passKind: pass?.kind ?? null,
      resumesMade: run.resumeCount,
      maxResumes: bound,
      fromLaneId: pass?.lane ?? null,
      resumeAfter: run.resumeAfter,
      selection,
      now,
    }),
  };
}

/**
 * Move a parked run onto another lane now, at the operator's press (issue
 * #202) — or refuse, with the reason. Null when no such run exists.
 *
 * Decided freshly here rather than trusting what the card was shown: the
 * fleet moves between the GET and the press (a sweep may have resumed the run
 * itself, another session may have spent the day's last dollar), and a press
 * has to be judged against the fleet as it is when the money is spent.
 *
 * The move is the early resume's body (`queueResumedPass`): the paused pass
 * queued again on the same branch, its lineage recorded so the attempt's
 * budget follows it, the session carried where the transcript survived,
 * `resumeCount` bumped when the move is queued, and the run left visibly
 * `rate_limited` until the pass actually starts. It counts against the same
 * resume bound a clock-driven resume does, and it is announced on the issue
 * with the lane and what it costs — in the same sentence the sweep's own move
 * uses, so a human reading the thread cannot tell the two apart on the money.
 * What differs is who decided: the comment says the operator moved it, and
 * that the wall was still standing when they did.
 *
 * The target is advisory, exactly as a failover's is: `startTask` re-asks the
 * ranking as the pass starts, so a wall that lifted in between sends it back
 * to the cheaper lane, and `tasks.lane` — not this comment — records where it
 * actually ran.
 */
export async function moveParkedRunToLane(
  runId: string,
  now: Date = new Date()
): Promise<ManualLaneMoveResult | null> {
  const reading = readManualLaneMove(runId, now);
  if (reading === null) return null;
  if (!reading.decision.ok) return reading.decision;

  const { offer } = reading.decision;
  const from = offer.fromLaneId ?? "its lane";
  // Non-null by construction: a move is only offered while the wall stands.
  const resets = new Date(offer.resumeAfter).toUTCString();

  const taskId = await queueResumedPass(
    reading.runId,
    reading.issueRef,
    laneMoveWording(
      {
        toLaneId: offer.toLaneId,
        toLaneLabel: offer.toLaneLabel,
        toLaneBilling: offer.billing,
        toLaneRateUsdPerMTok: offer.rateUsdPerMTok,
        resume: offer.resume,
        maxResumes: offer.maxResumes,
      },
      {
        log: (run) =>
          `[autonomy] Operator moved ${reading.issueRef} onto ${offer.toLaneId} ` +
          `(attempt ${run.attempt}, resume ${offer.resume}/${offer.maxResumes}; ` +
          `the window on ${from} stands until ${resets})`,
        opening: (run) =>
          `Moved onto another lane by the operator (attempt ${run.attempt}): ` +
          `the window on \`${from}\` does not reset until ${resets}, and`,
      }
    )
  );

  // Nothing was queued: the run moved on between the decision and the write
  // (a sweep resumed it, or a human cancelled it). Judged again rather than
  // reported as a success the ledger does not show — and since every path
  // that queues nothing is synchronous up to that point, the second reading
  // sees exactly the state that refused the first, so it is always a refusal.
  if (taskId === null) {
    const again = readManualLaneMove(runId, now);
    if (again === null) return null;
    return again.decision.ok ? refuse("already-resuming") : again.decision;
  }

  return { ok: true, offer, taskId };
}
