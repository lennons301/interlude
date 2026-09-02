import { db } from "@/db";
import { tasks, messages, projects, runs, isGenerationSession } from "@/db/schema";
import { eq, and, isNull, asc, desc } from "drizzle-orm";
import { newId } from "../ulid";
import {
  observeContainerAbsent,
  createWorkspaceContainer,
  execSetup,
  execAgentTurn,
  execFallbackCommitAndPush,
  readContainerFile,
  removeContainer,
  stopContainer,
  startContainer,
  writeContainerFile,
  type RunningContainer,
} from "../docker/container-manager";
import { checkMemoryAdmission } from "./capacity";
import { runBoundedProbe } from "../timeout";
import { type TurnResult } from "./output-parser";
import { getStreamRecorder } from "./stream-recorder";
import { parseReviewVerdict } from "./autonomy/verdict";
import { parseTriageExit } from "./autonomy/triage";
import { passProducedResult } from "./autonomy/pass-output";
import { cancelOrphanedRunTasks } from "./autonomy/review-tasks";
import { MAX_ATTEMPTS, TRIAGE_MAX_TURNS } from "./autonomy/budgets";
import { resolvePassBudget, spendCarriedIntoPass } from "./pass-budget";
import { scanPorts } from "./port-scanner";
import {
  getConfig,
  resolveAgentEffort,
  type AgentPassKind,
} from "../config";
import { getSettingsOverrides } from "../settings";
import { getLaneCatalog } from "../lanes/catalog";
import { bookTaskCost } from "./spend";
import { resolveLane, type ResolvedLane } from "../lanes/resolve";
import { readLaneCrossing } from "../lanes/overflow-state";
import { payerChanged, type LaneCrossing } from "../lanes/overflow";
import type { LaneBilling } from "../lanes/lane-config";
import { noteOnceOnFeed } from "../tasks/feed-note";
import {
  chargeForTurn,
  costOverstatement,
  type TurnCharge,
} from "../lanes/lane-cost";
import { getHarnessAdapter } from "../harness/registry";
import { getDocker } from "../docker/client";
import { getInstallationToken } from "../github/client";
import { commentOnIssue, parseIssueRef } from "../github/issues";
import { parseRepoFromGitUrl } from "../github/repo";
import { createDraftPr, markPrReady, shouldOpenDraftPr } from "../github/pull-requests";
import { notifyTaskQueued, notifyTaskCompleted, notifyTaskFailed, notifyTaskIdle, notifyRunBlocked } from "../discord/notifications";
import { decideNext, passOutcomeSnapshot, type Action } from "./autonomy/decide";
import { composeSeed, composeSessionTurn } from "../sessions/seed";
import { processSingleton } from "../process-singleton";
import { storedTaskStatus, taskIsFinished } from "../tasks/stored-status";
import type { ParkedAdoption } from "./parked-adoption";
import {
  detectQuotaRejection,
  type TurnQuotaSignals,
} from "../quota/rate-limit-rejection";
import { describeRateLimitType } from "../quota/rate-limit-event";
import { normalizeModelTier } from "../model-tiers";
import {
  containerTranscriptPath,
  MAX_TRANSCRIPT_BYTES,
  readTranscript,
  saveTranscript,
} from "../quota/session-transcript";

/**
 * Track all active task containers for cancellation and idle polling.
 *
 * Process-wide, not module-wide (issue #159). This module is evaluated twice —
 * once in the graph Next compiles `instrumentation.ts` into, where the queue
 * loop and the sweep read this map, and once in the app-router graph, where
 * `POST /api/tasks/[id]/complete` and `.../cancel` mutate it. As a module-level
 * `const` those were two maps: completing an interactive session from the UI
 * deleted the entry the route could see and left the one the queue counted, so
 * one normal UI close held the box's only slot until the app was restarted. See
 * {@link processSingleton} for why `globalThis` is the only fix available.
 */
const activeTasks = processSingleton(
  "turn-manager.activeTasks",
  () =>
    new Map<
      string,
      {
        container: RunningContainer;
        state: "setup" | "running" | "idle" | "completing";
        kind: AgentPassKind;
      }
    >()
);

export function getActiveTasks() {
  return activeTasks;
}

/**
 * Put a parked container back in `activeTasks` as idle, after a restart lost
 * the map (issue #136).
 *
 * `activeTasks` lives only in this process's memory and `startTask` was its
 * only writer, so an orchestrator restart while a run sat `blocked` severed the
 * one route from the owner's answer to the container: queue step 2 iterates
 * this map and nothing else, boot recovery deliberately leaves a blocked run
 * alone (it waits on a human, not on a lost turn), and the reaper deliberately
 * preserves its container. Correct in isolation, and in combination it stranded
 * the run permanently — the answer landing in `messages` with `deliveredAt`
 * null, forever, and no human action able to clear the card.
 *
 * The handle is reconstructed from the task row, exactly as `completeTask` has
 * always reconstructed one when it finds no entry. `checkout: "existing"` says
 * the container is already on its branch, and the entry goes in as `idle` with
 * its real kind, which is what makes it *parked* — so it holds no slot, just as
 * it held none before the restart, and the existing delivery path resumes it on
 * the next poll with no further changes.
 *
 * The caller owns deciding *whether* to adopt (see `planParkedAdoption`); this
 * only does it, and refuses to overwrite a live entry so a second boot pass, or
 * a task that has meanwhile started for real, cannot lose a handle.
 */
export function adoptParkedContainer(adoption: ParkedAdoption): boolean {
  if (activeTasks.has(adoption.taskId)) return false;

  activeTasks.set(adoption.taskId, {
    container: {
      container: getDocker().getContainer(adoption.containerName),
      id: adoption.containerId,
      name: adoption.containerName,
      previewSubdomain: adoption.previewSubdomain,
      checkout: "existing",
    },
    state: "idle",
    kind: adoption.kind,
  });
  return true;
}

/**
 * Drop every entry whose task row has reached a terminal status, or vanished —
 * the invariant that no session entry outlives its task (issue #159). Returns
 * the ids dropped, for the caller's log.
 *
 * A true invariant rather than a heuristic, and it needs no Docker call: a
 * `completed` / `failed` / `cancelled` task runs no agent process and owns no
 * container the orchestrator will ever exec into again, so an entry claiming
 * otherwise can only be bookkeeping the terminal path failed to hand back.
 * Nothing *should* reach here — every terminal path deletes its own entry — but
 * when one does, pickup has to self-heal within a poll instead of wedging the
 * box until the app is restarted. That was the whole cost of #159: the count
 * lives in memory, so no label, cancel or container action reaches it.
 *
 * Deliberately does not touch the container. If a terminal task's container
 * somehow still exists, the stale-container reaper owns it — it removes any
 * `interlude-task-*` container whose task is neither live nor owned by a live
 * run — and removing it from here would mean racing that. Letting go of the
 * slot is this function's whole job.
 *
 * Parked entries are never at risk: a pass awaiting its verdict or blocked on a
 * question is `running`/`blocked`, so its row is not terminal (and it holds no
 * slot anyway — see {@link isParked}).
 */
export function pruneTerminalActiveTasks(): string[] {
  const dropped: string[] = [];
  for (const taskId of activeTasks.keys()) {
    if (!taskIsFinished(taskId)) continue;
    activeTasks.delete(taskId);
    dropped.push(taskId);
  }
  return dropped;
}

/**
 * Give up on a live session whose container the daemon has definitively lost
 * (issue #159): record the task `failed`, say so in its feed, and drop the
 * entry. Returns whether it did — false means this task is not ours to
 * finalize.
 *
 * Freeing the slot alone would not be enough. A task left `running` with no
 * container is a zombie the fleet can never resolve: `isLiveTask` still counts
 * it, so the dashboard reads a slot busy that the queue reads free — the very
 * disagreement #159 complained about, re-created by the thing meant to fix it —
 * its feed shows no reason, and any follow-up message the owner sends queues
 * against a session with nothing to deliver it. Recording the failure is what
 * makes the two surfaces agree again and lets the composer close.
 *
 * Only a session no run owns, which is to say an interactive one. A pass inside
 * a run has three recovery routes that own this exact situation and account for
 * it properly — the #95 reaper for a review, the #97 interruption bound for an
 * implement pass, the #106 dangling-run sweep at boot — and a bare `failed`
 * written from here would either burn an attempt that no work failed or strand
 * the run mid-status. So an autonomous pass keeps its entry and its slot, and
 * the caller says so out loud rather than acting.
 */
export function abandonSessionWithoutContainer(taskId: string, reason: string): boolean {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task || task.runId) return false;

  insertSystemMessage(taskId, `Session ended: ${reason}`);
  updateTask(taskId, { status: "failed", containerStatus: null, containerId: null });
  activeTasks.delete(taskId);
  return true;
}

/**
 * An idle autonomous container is *parked*: an implement pass waiting on its
 * review verdict, or blocked on a question to the owner (issue #19), keeps its
 * container (so the verdict's fix-up or the owner's answer can be a follow-up
 * turn in the same attempt) but runs no agent process, so it does not hold a
 * slot — and since #93 the container is `docker stop`ped while parked so it
 * holds no memory either (see parkContainer). An idle interactive session does
 * hold its slot — its dev server and the owner's next message are live
 * concerns. Without this distinction, two parked implements plus their two
 * queued reviews would deadlock a two-slot box.
 */
export function isParked(entry: { state: string; kind: string }): boolean {
  return entry.state === "idle" && entry.kind !== "interactive";
}

/**
 * Free a parked autonomous container's memory (issue #93). A pass awaiting its
 * review verdict or blocked on a question keeps its container so a fix-up or
 * answer can resume the *same* attempt — but it runs no agent process, so the
 * node/dev-server RSS it held while parked was pure overcommit risk: several
 * parked at once OOM-thrashed the host on 2026-08-04. `docker stop` frees all
 * of it; the container's filesystem and branch state survive, and
 * `resumeParkedContainer` restarts it in ~1s when the next turn arrives.
 * Interactive sessions are never parked (their dev server and next message are
 * live concerns), so they keep their container. Idempotent — a no-op when the
 * task has no active entry or is not parked.
 */
async function parkContainer(taskId: string): Promise<void> {
  const entry = activeTasks.get(taskId);
  if (!entry || !isParked(entry)) return;
  await stopContainer(entry.container);
  console.log(`[orchestrator] Parked container for task ${taskId} stopped to free memory`);
}

/**
 * Restart a container `parkContainer` stopped, before delivering its next turn
 * (issue #93). Refuses when the box has no memory headroom — the caller defers
 * to a later poll rather than overcommit, since resuming a parked container is
 * not slot-gated. Returns false when the resume was deferred (the container is
 * left stopped and the queued turn undelivered); true once it is running. A
 * no-op success for interactive containers, which are never stopped.
 */
async function resumeParkedContainer(
  taskId: string,
  running: RunningContainer
): Promise<boolean> {
  const entry = activeTasks.get(taskId);
  if (!entry || !isParked(entry)) return true;

  const admission = await checkMemoryAdmission();
  if (!admission.ok) {
    console.log(
      `[orchestrator] Deferring resume of parked task ${taskId} — ${admission.reason}`
    );
    return false;
  }
  await startContainer(running);
  return true;
}

export function getTaskState(taskId: string) {
  return activeTasks.get(taskId)?.state ?? null;
}

/**
 * Move a live session's state along, tolerating an entry that is no longer
 * there. A turn does not own its entry: the owner can complete or cancel the
 * task from the UI or Discord while the turn is mid-flight — `completeTask` is
 * fire-and-forget from its route — and those paths delete the entry and remove
 * the container as they go.
 *
 * These writes used to be `activeTasks.get(taskId)!.state = ...`, which turns
 * that ordinary race into a TypeError thrown from inside `startTask`'s try, and
 * so into a *failed* task (with a Discord embed and an issue comment) for a
 * session the owner had just successfully completed. The state of a session
 * that has ended is not a thing worth crashing over — the terminal path already
 * recorded the outcome.
 */
function setTaskState(
  taskId: string,
  state: "setup" | "running" | "idle" | "completing"
): void {
  const entry = activeTasks.get(taskId);
  if (entry) entry.state = state;
}

/**
 * Start a task: create container, setup workspace, run initial turn,
 * then enter idle loop waiting for user messages.
 */
export async function startTask(taskId: string): Promise<void> {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) throw new Error(`Task ${taskId} not found`);

  const proj = db
    .select()
    .from(projects)
    .where(eq(projects.id, task.projectId))
    .get();
  if (!proj) throw new Error(`Project ${task.projectId} not found`);
  if (!proj.gitUrl) throw new Error(`Project ${proj.name} has no git URL`);

  // Autonomous passes (implement, review, triage) run with their description
  // as the fully framed pass prompt, baked when the sweep created the task.
  // A review pass checks out the PR's existing branch rather than creating
  // one; a triage pass reads the default branch through a throwaway local
  // branch it never pushes.
  const isImplementPass = task.kind === "implement";
  const isReviewPass = task.kind === "review";
  const isTriagePass = task.kind === "triage";
  // An integration-repair pass (issue #54) is an implement-shaped pass on an
  // existing PR branch: it checks the branch out, merges the default branch
  // in, pushes, and parks awaiting review exactly like an implement pass —
  // but it is never an attempt, so it skips attempt-exhaustion accounting.
  const isRepairPass = task.kind === "repair";
  const isImplementShaped = isImplementPass || isRepairPass;
  const isAutonomousPass = isImplementShaped || isReviewPass || isTriagePass;
  const issueNumber = task.githubIssue ? parseIssueRef(task.githubIssue)?.number : undefined;
  if (isImplementShaped && !issueNumber) {
    throw new Error(`${task.kind} task ${taskId} has no parsable GitHub issue ref`);
  }
  if (isReviewPass && !task.branch) {
    throw new Error(`Review task ${taskId} has no branch to check out`);
  }
  const branch = isImplementShaped
    ? `agent/issue-${issueNumber}`
    : isReviewPass
      ? task.branch!
      : `agent/${taskId}`;

  const userPrompt = task.description
    ? `${task.title}\n\n${task.description}`
    : task.title;
  // A generation session's first turn is the composed seed (issue #63): the
  // deterministic slash-passthrough prompt for its session skill, with the
  // user's title/description as the skill's agenda and any issue anchor passed
  // as a reference the agent fetches itself. Sessions are always interactive
  // (no run row), so this never collides with the autonomous-pass branch.
  const prompt = task.sessionSkill
    ? composeSeed({
        sessionSkill: task.sessionSkill,
        sessionIssue: task.sessionIssue,
        agenda: userPrompt,
      })
    : isAutonomousPass
      ? task.description
      : `${userPrompt}\n\nWhen you are done with each request, commit all your changes with a descriptive commit message. Stay ready for follow-up instructions.`;

  const run = task.runId
    ? db.select().from(runs).where(eq(runs.id, task.runId)).get()
    : undefined;

  let running: RunningContainer | null = null;
  // Whether the initial turn reached a terminal agent result (a `result`
  // event). Stays false if the container dies mid-turn — the signal the catch
  // block uses to tell an infra death (interruption) from a work failure
  // (issue #97).
  let producedResult = false;

  // The crossing (issue #173) — deliberately *outside* the failure path below,
  // and the one thing that is. A pass the money guards refuse is **held, not
  // failed**: it stays `queued` with the reason on its feed, because a
  // confirmation is one press away and the cash cap lifts itself at midnight.
  // The poll loop already steps over such a task so it cannot hold the work
  // behind it, which makes this the guard for every *other* way here — the
  // manual run route, and the race where the day's confirmation is withdrawn
  // between that check and this one. Read once and handed to the resolver
  // below, so the lane a pass runs on and the reason it was held cannot come
  // from two different readings of the fleet.
  const crossing = readLaneCrossing(task.kind);
  if (crossingHoldsPass(taskId, crossing)) return;

  // Everything from here is inside the failure path. Lane resolution
  // (issue #172) is why the boundary sits this early: an unavailable lane is a
  // routinely reachable misconfiguration, and a throw *outside* the try would
  // leave the task `queued` for the poll loop to pick up again every two
  // seconds forever. Inside, it fails the task with the reason on the feed,
  // and an implement pass routes to the bounded interruption path like any
  // other infra death.
  try {
    // The execution lane this pass runs on (issue #172): the harness adapter,
    // the endpoint, the credentials and the model identifier standing behind the
    // tier that kind of pass runs at — pinned by kind (issue #74) and, for an
    // implement-shaped or interactive pass, overridable by the run's `model:`
    // directive (issue #80).
    //
    // Resolved *before* the container is provisioned, so a lane whose named
    // variables are absent fails the pass here, naming them, rather than dying
    // inside a live harness twenty seconds later with "Not logged in".
    //
    // Read fresh from the settings row, not from a cached config: a UI-set tier
    // or lane (issues #166, #172) has to reach the next pass without a restart,
    // and `getConfig()` memoises on first read.
    const pass = requirePassLane(task.kind, run?.model ?? null, crossing);
    const passLane = pass.lane;
    const passModel = passLane.model;

    // Say so on the feed when this pass costs real money (issue #173).
    // Written before the container, so it is on the screen while the workspace
    // is still being built.
    announceCrossing(taskId, pass, {
      lane: task.lane,
      laneBilling: task.laneBilling,
    });

    // The reasoning-effort level this pass runs at (issue #81), the other half
    // of the cost/quality dial. Pinned by kind and, for an implement-shaped or
    // interactive pass, overridable by the run's `effort:` directive. Passed to
    // every turn as `--effort` and recorded on the run row below.
    const passEffort = resolveAgentEffort(task.kind, getConfig(), run?.effort ?? null);

    // What this attempt has already spent on *this* pass, across the quota
    // walls it was continued from — the pauses it was resumed from (issue
    // #169) and the tier steps it was retried from (issue #170) — and zero for
    // every pass that is neither. The allowance below is stated net of it,
    // because each of those is a new task row for the same attempt while every
    // budget control here is scoped to the row: left gross, one attempt's real
    // ceiling would be `(1 + continuations) x run.budgetUsd`.
    const carriedCostUsd = spendCarriedIntoPass(task);

    // What this pass may spend: its kind's allowance, net of the above.
    const passBudget = resolvePassBudget({
      kind: task.kind,
      attemptBudgetUsd: run?.budgetUsd ?? null,
      carriedCostUsd,
    });

    // Defence in depth, on the one kind for which "the attempt has no money
    // left" and "the attempt fails" are the same sentence. An implement pass
    // cannot actually reach this — exhaustion is judged ahead of the pause, so
    // an attempt at its ceiling fails rather than parks, and every link in a
    // resume chain is therefore strictly under it — but if it ever did, this is
    // the answer, and it is given before a ~2 GiB container is built to run a
    // turn with no money in it. Deliberately not repair: a repair pass is never
    // an attempt and may not fail one, and its allowance is not netted anyway.
    if (isImplementPass && run && passBudget.remainingUsd !== null && passBudget.remainingUsd <= 0) {
      await failImplementAttempt(
        taskId,
        run.id,
        `budget exhausted ($${passBudget.carriedCostUsd.toFixed(2)} of ` +
          `$${(passBudget.allowanceUsd ?? 0).toFixed(2)} spent before this resume)`
      );
      return;
    }

    // Update task status, and record the lane this pass runs on with it
    // (issues #172, #174). The billing kind is written *here*, on the task,
    // because the task is the unit money is spent by: a run's lane covers its
    // implement pass, but triage owns no run and an interactive session never
    // has one, and the real-money cap has to see every dollar that went
    // through a metered lane today or it is not measuring money.
    updateTask(taskId, {
      status: "running",
      branch,
      containerStatus: "setup",
      lane: passLane.id,
      // The crossing's billing kind, not the lane's declared one (issue #173):
      // an overage means these dollars are cash however the lane describes
      // itself, and the real-money ledger keys off exactly this column.
      laneBilling: pass.billing,
      // The tier beside the lane, for the reason the run row records both
      // (issue #172): the pair is what makes this task's cost interpretable
      // after the fact, and interactive work — the only kind that crosses onto
      // a paid lane — has no run row to record it on.
      tier: passLane.tier ?? passModel,
    });
    insertSystemMessage(taskId, `Provisioning agent container...${proj.dopplerToken ? " (Doppler configured)" : ""}`);

    // Only an implement-shaped pass moves the run to `implementing` — a review
    // pass starting must not drag a `reviewing`/`gated` run backwards. A repair
    // pass keeps the run's original startedAt so the dashboard's elapsed time
    // does not jump when a conflict is repaired mid-life.
    if (run && isImplementShaped) {
      // Record the implement-pass lane, tier and effort on the run — they drive
      // the bulk of a run's spend, so they are the substrate, tier and depth
      // the run's cost should be read against, and the lane is what says
      // whether that cost was subscription quota or real money (issue #172). A
      // review pass writes its own (cheaper/lower) model and effort nowhere on
      // the run, leaving these stable. Repair keeps the original implement
      // values.
      //
      // The *tier* is what goes in `model`, not the identifier it resolved to
      // (issue #172): this column is read back as the run's `model:` directive
      // on every later pass, and a lane-specific identifier
      // ("anthropic/claude-sonnet-4.5") names no tier, so recording it would
      // silently drop the directive the moment the fleet left an
      // alias-mapped lane. With the lane recorded beside it, tier + lane still
      // gives the identifier. A pinned raw id (no tier) is recorded verbatim,
      // exactly as before.
      db.update(runs)
        .set({
          status: "implementing",
          startedAt: run.startedAt ?? new Date(),
          lane: passLane.id,
          laneBilling: pass.billing,
          model: passLane.tier ?? passModel,
          effort: passEffort,
          // A resumed run stops waiting on a clock the moment its pass starts
          // (issue #169). Cleared here rather than when the resume was decided,
          // so a restart in between leaves a run that is still visibly paused
          // with the window it is waiting on, rather than one pretending to be
          // claimed.
          resumeAfter: null,
        })
        .where(eq(runs.id, run.id))
        .run();
    }

    // Notify Discord channel that task is queued — but not for tasks created
    // from Discord, which already got their queued embed posted in client.ts,
    // and not for autonomous passes: their lifecycle lives on the issue thread
    // and Discord stays push-only for exceptional events.
    if (proj.discordChannelId && !task.discordMessageId && !isAutonomousPass) {
      notifyTaskQueued(proj.discordChannelId, {
        id: taskId,
        title: task.title,
        projectName: proj.name,
      }).then((msgId) => {
        if (msgId) updateTask(taskId, { discordMessageId: msgId });
      }).catch(console.error);
    }

    // Create container. Review and triage passes receive no credential beyond
    // the App token their setup uses for cloning — not even the project's
    // Doppler secrets: they read code, they don't run the app. A repair pass
    // is implement-shaped — it merges, pushes, and runs the repo's CI-equivalent
    // check set (issue #132) — so it gets the same Doppler secrets an implement
    // pass does, or a check that needs them would behave differently than under
    // implement.
    running = await createWorkspaceContainer({
      taskId,
      gitUrl: proj.gitUrl,
      branch,
      dopplerToken:
        isReviewPass || isTriagePass ? undefined : (proj.dopplerToken ?? undefined),
      // Review/repair check out the PR branch (it must exist); an implement
      // pass adopts agent/issue-<n> if a previous attempt already pushed it, so
      // a retry continues that branch instead of racing a fresh one and being
      // rejected non-fast-forward (issue #72); triage/interactive branch fresh.
      checkout: isReviewPass || isRepairPass ? "existing" : isImplementPass ? "adopt" : "create",
    });
    activeTasks.set(taskId, { container: running, state: "setup", kind: task.kind });

    updateTask(taskId, {
      containerId: running.id,
      containerName: running.name,
      previewSubdomain: running.previewSubdomain,
    });

    // Start container and run setup
    await running.container.start();
    const { skillsVersion } = await execSetup(running);

    // Log the resolved mattpocock-skills version at session start (issue #60):
    // visibly in the feed, and on the run ledger where a run exists — the
    // forensic trail for "what skill version ran?". A failed install never
    // reaches here — execSetup throws before any agent turn.
    if (skillsVersion) {
      insertSystemMessage(taskId, `mattpocock-skills plugin installed (v${skillsVersion})`);
      // First-write-wins on the ledger: a run's later review/repair pass runs
      // its own setup, but the forensic value is the implement pass's version
      // (the run's first pass) — mirroring how model/effort pin to the
      // implement pass. The `isNull` guard stops a later pass clobbering it,
      // since the plugin is unpinned and its version may drift between passes.
      if (task.runId) {
        db.update(runs)
          .set({ skillsVersion })
          .where(and(eq(runs.id, task.runId), isNull(runs.skillsVersion)))
          .run();
      }
    } else {
      // A successful setup always echoes the version marker, so a null here
      // means it was lost/mangled in the exec stream — surface it rather than
      // silently dropping the forensic trail.
      console.warn(`[orchestrator] Task ${taskId} setup produced no skills version marker`);
    }

    insertSystemMessage(taskId, "Agent started.");
    updateTask(taskId, { containerStatus: "running" });
    setTaskState(taskId, "running");

    // Notify GitHub issue that agent has started. Autonomous passes skip
    // this: the claim comment already announced the run with the task link,
    // and review passes report through their verdict.
    if (task.githubIssue && !isAutonomousPass) {
      const domain = process.env.DOMAIN ?? "interludes.co.uk";
      commentOnIssue(
        task.githubIssue,
        `Agent working\n\n[View in Interlude](https://${domain}/tasks/${taskId})`
      ).catch(console.error);
    }

    // A resumed pass (issue #169) opens with the paused pass's conversation put
    // back where the harness keeps it, and continues that session rather than
    // starting a new one. Every other pass gets `undefined` and behaves exactly
    // as before.
    const resumeSessionId = isImplementShaped
      ? await restoreSessionTranscript(task, running)
      : undefined;

    // Run initial turn. An autonomous pass is one whole turn, carrying the
    // allowance resolved above (net of anything a quota pause already spent on
    // it). Review and triage keep their raw stream: the structured exit is
    // parsed from it.
    const turnResult = await runTurn(taskId, running, prompt, resumeSessionId, {
      maxBudgetUsd: passBudget.remainingUsd ?? undefined,
      maxTurns: isTriagePass
        ? TRIAGE_MAX_TURNS
        : isReviewPass || isRepairPass
          ? undefined
          : (run?.maxTurns ?? undefined),
      captureRaw: isReviewPass || isTriagePass,
      lane: passLane,
      effort: passEffort,
      // A generation session's exec gets a `gh` token; no autonomous pass does (#62).
      isGenerationSession: isGenerationSession(task),
    });

    // A terminal `result` event arrived — the turn ran to completion, so any
    // failure from here is the work's, not the container's (issue #97).
    producedResult = turnResult.subtype !== null;

    // Store session ID and cost
    updateTask(taskId, {
      sessionId: turnResult.sessionId,
      containerStatus: "idle",
      totalCostUsd: turnResult.costUsd,
    });
    if (run) syncRunCost(run.id);
    setTaskState(taskId, "idle");

    if (isReviewPass) {
      // Reviews never write: no commit, no push, no PR. Parse the verdict,
      // store it on the run for the sweep to act on, and tear down.
      await finishReviewPass(taskId, running, run?.id ?? null, turnResult.raw ?? "");
      return;
    }

    if (isTriagePass) {
      // Triage never writes either: parse the exit, store it on the task
      // for the sweep to apply, and tear down.
      await finishTriagePass(taskId, running, turnResult.raw ?? "");
      return;
    }

    // Commit and push after turn completes
    await runPostTurnCommitAndPush(taskId, running);

    if (isImplementShaped) {
      // A turn that returned no terminal result event died ungracefully
      // mid-flight (the process exited before finishing rather than throwing) —
      // an interruption, not a spent attempt (issue #97). Checked before
      // exhaustion: with no result there is no trustworthy cost or subtype to
      // judge exhaustion from, and the branch is pushed after every turn so any
      // work survives the re-claim. Repair passes are never attempts, so this
      // only diverts a real implement pass.
      if (isImplementPass && run && !producedResult) {
        await interruptImplementPass(
          taskId,
          run.id,
          "container exited without a terminal result"
        );
        return;
      }
      // Exhaustion first (issue #18) — but only for a real implement attempt.
      // A repair pass (issue #54) is never an attempt, so a repair that spent
      // its budget without clearing the conflict still parks: the sweep's
      // conflict check then escalates the still-CONFLICTING PR to a human,
      // rather than the repair burning a strike.
      if (isImplementPass) {
        const exhaustion = run
          ? attemptExhaustion(
              run,
              passBudget.carriedCostUsd + turnResult.costUsd,
              turnResult.subtype
            )
          : null;
        if (exhaustion) {
          await failImplementAttempt(taskId, run!.id, exhaustion);
          return;
        }
      }
      // The pass's turn is over: park the run on the quota clock if the account
      // refused the pass (issue #168) — container torn down, no attempt spent;
      // park it blocked if its final message carries the BLOCKED marker on any
      // line (issue #107) — container kept alive, question escalated to the
      // owner (issue #19); or fail the attempt if it left no PR and no
      // question, so the run cannot dangle as a ghost (issue
      // #106). Otherwise the initial turn is the whole pass: mark the PR ready
      // and park the container awaiting review — it stays alive (holding no
      // slot) so a request-changes verdict can deliver a fix-up turn into the
      // same attempt. The run stays `implementing`; the sweep's gate evaluation
      // takes over from here.
      const decision = await evaluatePassOutcome(taskId, turnResult);
      if (decision === "proceed") await finishImplementPass(taskId);
      return;
    }

    await scanForDevServer(taskId, running);
    await postIdleNotification(taskId);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);

    // The turn died because the task it was running ended underneath it: the
    // owner completed or cancelled the session from the UI or Discord, which
    // deletes the session entry and force-removes the container while this turn
    // is still in flight (the complete route is fire-and-forget). Everything
    // from here would overwrite that outcome — a `completed` task re-marked
    // `failed`, a "task failed" Discord embed and issue comment for work the
    // owner successfully closed. The terminal path has already recorded what
    // happened and pushed the branch, so there is nothing to add (issue #159).
    if (taskIsFinished(taskId)) {
      console.log(
        `[orchestrator] Turn for task ${taskId} ended with its task already ` +
          `${storedTaskStatus(taskId) ?? "gone"} — not overriding that outcome (${reason})`
      );
      return;
    }

    // An implement pass that threw before delivering a terminal result died to
    // the container, not to bad work (issue #97): a mid-turn OOM (exit 137),
    // docker error, or lost stream. Route it to the interruption bound rather
    // than the attempt budget — its own handler records the ledger, messages
    // the issue and cleans up, so return before the generic failure tail
    // (which would announce a failure and re-remove the container).
    if (isImplementPass && task.runId && !producedResult) {
      insertSystemMessage(taskId, `Error: ${reason}`);
      await interruptImplementPass(taskId, task.runId, `container error: ${reason}`);
      return;
    }

    // A triage pass that died delivered no exit. Store the failure as an
    // unparseable result so the fail-closed path (nothing applied, the
    // owner told once, needs-triage kept) runs instead of a silent retry.
    // But never clobber an exit finishTriagePass already stored — a teardown
    // failure after the store must not turn a good exit into an unparseable
    // one (the sweep applies stored exits regardless of task status).
    const storedExit = isTriagePass
      ? db.select().from(tasks).where(eq(tasks.id, taskId)).get()?.triageResult
      : null;
    // A review pass the sweep already reaped as dead (issue #95) is `failed`
    // before this catch runs — the reaper queued its replacement, so this
    // dead pass must not store a verdict over it below.
    const alreadyReaped = isReviewPass && storedTaskStatus(taskId) === "failed";
    updateTask(taskId, {
      status: "failed",
      containerStatus: null,
      ...(isTriagePass && storedExit == null
        ? {
            triageResult: {
              kind: "unparseable" as const,
              reason: `triage pass failed: ${reason}`,
            },
          }
        : {}),
    });
    if (task.runId) {
      if (isReviewPass) {
        // A review pass that died is not a failed attempt — the implement work
        // is intact. If a terminal result arrived, the failure is the review's
        // own: store it as an unparseable verdict so the fail-closed path (no
        // merge, human-signoff, owner told) runs. If none did — an infra death
        // (OOM, docker error, lost stream) — leave the result null so the sweep
        // queues a fresh replacement review (issue #97), consuming no
        // format-retry, exactly the #95 reaper's recovery. Never write over a
        // verdict the sweep already reaped and replaced (issue #95).
        if (producedResult && !alreadyReaped) {
          db.update(runs)
            .set({
              reviewResult: {
                kind: "unparseable",
                reason: `review pass failed: ${reason}`,
              },
            })
            .where(eq(runs.id, task.runId))
            .run();
        }
      } else {
        finishRun(task.runId, "failed", `container error: ${reason}`);
      }
    }
    insertSystemMessage(taskId, `Error: ${reason}`);

    // An infra death of a review pass auto-recovers — the sweep re-queues a
    // replacement — so it is not a failure to announce on the issue or in
    // Discord (issue #97). Every other death here is a genuine failure.
    const reviewInfraDeath = isReviewPass && !producedResult;

    if (task.githubIssue && !reviewInfraDeath) {
      const domain = process.env.DOMAIN ?? "interludes.co.uk";
      commentOnIssue(
        task.githubIssue,
        `Task failed -- check [Interlude](https://${domain}/tasks/${taskId}) for details`
      ).catch(console.error);
    }

    if (proj.discordChannelId && !reviewInfraDeath) {
      notifyTaskFailed(proj.discordChannelId, {
        id: taskId,
        title: task.title,
        error: reason,
      }).catch(console.error);
    }

    await removeTaskContainer(taskId, running);
  }
}

/**
 * Put a paused pass's conversation back into its fresh container, and say
 * which session the turn should continue (issue #169).
 *
 * Returns the session id only when the transcript actually landed. Everything
 * that can go wrong here — no session recorded, no saved transcript, a write
 * the daemon refused — degrades to the declared fallback rather than to a
 * failure: the pass runs on the same branch, with the work already pushed,
 * and its prompt (which carries the original brief behind the resume
 * preamble) stands on its own. Resuming a session the container has never
 * heard of would be the one genuinely bad outcome, so it is the one thing this
 * refuses to do.
 *
 * The task's `sessionId` is set only by the resume executor, so an ordinary
 * first pass never reaches past the first line.
 *
 * Exported as the seam it is, like `evaluatePassOutcome`: whether a resumed
 * pass continues its session or falls back is decided here, and a test that
 * wanted to assert it otherwise would have to provision a container.
 */
export async function restoreSessionTranscript(
  task: typeof tasks.$inferSelect,
  running: RunningContainer
): Promise<string | undefined> {
  if (task.sessionId === null || task.runId === null) return undefined;

  const transcript = readTranscript(task.runId);
  if (transcript === null) {
    insertSystemMessage(
      task.id,
      "Resuming without the paused session's transcript — this pass continues " +
        "on the same branch, with the work pushed so far but no prior context."
    );
    return undefined;
  }

  try {
    await writeContainerFile(
      running.container,
      containerTranscriptPath(task.sessionId),
      transcript
    );
    insertSystemMessage(
      task.id,
      `Restored the paused session (${task.sessionId}) — continuing the same conversation.`
    );
    return task.sessionId;
  } catch (err) {
    console.error(
      `[orchestrator] Could not restore the session transcript for task ${task.id}:`,
      err
    );
    insertSystemMessage(
      task.id,
      "The paused session's transcript could not be restored — this pass " +
        "continues on the same branch without its prior context."
    );
    return undefined;
  }
}

/**
 * Copy a paused pass's conversation out of the container that is about to be
 * torn down (issue #169), and report whether it survived.
 *
 * Best-effort by design, and the ordering is the point: this runs before the
 * teardown and its failure changes nothing about the pause. A pause protects
 * the ticket's attempt; keeping the conversation only saves the resumed pass
 * some re-orientation, so a transcript that cannot be copied must never cost
 * the pause itself.
 */
async function preserveSessionTranscript(
  runId: string,
  sessionId: string | null,
  container: RunningContainer | null
): Promise<boolean> {
  if (sessionId === null || container === null) return false;
  try {
    const transcript = await readContainerFile(
      container.container,
      containerTranscriptPath(sessionId),
      // The store's ceiling, handed to the container so an over-size transcript
      // is refused before it is encoded rather than after it has been decoded
      // into this process.
      MAX_TRANSCRIPT_BYTES
    );
    if (transcript === null) {
      console.warn(
        `[autonomy] Run ${runId} paused with no readable transcript for session ` +
          `${sessionId} — its resume will start again on the same branch`
      );
      return false;
    }
    return saveTranscript(runId, transcript);
  } catch (err) {
    console.error(`[autonomy] Could not copy the transcript of run ${runId} out:`, err);
    return false;
  }
}

/**
 * The lane one pass runs on, with the two facts the lane itself cannot supply:
 * how its spend must be booked, and whether it got there by crossing off a
 * walled subscription lane (issues #172, #173).
 */
interface PassLane {
  lane: ResolvedLane;
  /**
   * Who pays for this pass — the lane's declared kind, or `metered` when an
   * active overage means subscription work is already being charged to the
   * card (issue #173). Recorded on the task and the run in place of
   * `lane.billing`, because the ledger's job is to say what was true when the
   * work ran.
   */
  billing: LaneBilling;
  /** The walled lane this pass overflowed off; null when it did not. */
  overflowedFrom: string | null;
  /** A line for the task's feed when the human should know that this pass
   * costs money; null when there is nothing new to say. */
  notice: string | null;
}

/**
 * The execution lane one pass runs on, or a throw naming what is missing
 * (issue #172) or what has to happen first (issue #173).
 *
 * Read fresh on every call rather than resolved once per pass: the catalog
 * itself is checked-in and cached, but which lane is primary lives on the
 * settings row, so a follow-up turn picks up a lane changed mid-session for
 * the same reason it picks up a tier changed mid-session — and, since #173,
 * so a session walled mid-conversation crosses onto a paid lane at its very
 * next turn, and one held for a confirmation starts the turn after the press.
 *
 * Throws rather than falling back. An unavailable lane is a configuration
 * fact, and the two wrong answers here — run on some other lane, or provision
 * a container and let the harness fail — are respectively "spend money nobody
 * authorised" and "the failure mode this ticket exists to remove".
 *
 * The crossing arrives already decided (issue #173), because it decides
 * *which* lane to resolve — an attended session whose subscription window is
 * walled runs on a metered lane instead — and because a refusal is the
 * caller's to answer: it is a hold, not a failure, and each caller holds its
 * own way. A refusal must therefore be dealt with before this is called;
 * `crossingHoldsPass` is how both callers do it.
 */
function requirePassLane(
  kind: AgentPassKind,
  ticketModel: string | null,
  crossing: LaneCrossing
): PassLane {
  const catalog = getLaneCatalog();
  if (!catalog.ok) {
    throw new Error(`No usable execution lanes — ${catalog.reason}`);
  }

  const resolution = resolveLane({
    catalog: catalog.catalog,
    kind,
    config: getConfig(),
    ticketModel,
    overrides: getSettingsOverrides(),
    env: process.env,
    // Null falls through to the primary, which is every pass that has not
    // crossed onto another lane.
    laneId: crossing.laneId,
  });
  if (!resolution.ok) throw new Error(resolution.reason);
  return {
    lane: resolution.lane,
    // The crossing's answer, not the lane's: only it knows about an overage.
    billing: crossing.billing ?? resolution.lane.billing,
    overflowedFrom: crossing.overflowedFrom,
    notice: crossing.notice,
  };
}

/**
 * Tell the owner — and the log — that this pass is spending real money
 * (issue #173): an overflow off a walled window, an overage picking the
 * subscription up, or a metered lane the operator made primary.
 *
 * Said when the *payer changes*, which is what makes it news, and not on every
 * turn thereafter. The obvious dedup — "is this line already the last thing on
 * the feed?" — is not enough on its own here: the sentence quotes the day's
 * running spend and the window's reset, so every turn would produce a line
 * that differs by a few cents and post again. What the task last recorded is
 * the honest comparison, and it is a column rather than memory, so it survives
 * a restart mid-session.
 *
 * The console line names the lane it came off, since "why did this session run
 * on openrouter?" is asked long after the feed has scrolled.
 */
function announceCrossing(
  taskId: string,
  pass: PassLane,
  /** What this task's previous turn recorded, or nulls before its first. */
  recorded: { lane: string | null; laneBilling: LaneBilling | null }
): void {
  if (pass.notice === null) return;
  if (!payerChanged(recorded, { laneId: pass.lane.id, billing: pass.billing })) {
    return;
  }
  noteOnceOnFeed(taskId, pass.notice);
  const from =
    pass.overflowedFrom === null
      ? ""
      : `, overflowed off ${pass.overflowedFrom}`;
  console.log(
    `[orchestrator] Task ${taskId} runs on ${pass.lane.id} (${pass.billing}${from})`
  );
}

/**
 * Put a crossing's refusal where the human will see it, once, and say whether
 * the pass may start (issue #173).
 *
 * A refused pass is **held, not failed**: the guards' two holds are a press
 * away and a cap that lifts itself at midnight, so there is work here to
 * start later rather than work to abandon. Shared with the queue loop, which
 * steps over a held session so it cannot hold the work behind it — the same
 * sentence and the same dedup wherever the refusal is met.
 */
export function crossingHoldsPass(
  taskId: string,
  crossing: LaneCrossing
): boolean {
  if (crossing.refusal === null) return false;
  if (noteOnceOnFeed(taskId, crossing.refusal.message)) {
    console.log(
      `[orchestrator] Task ${taskId} is not starting — ${crossing.refusal.reason} (issue #173)`
    );
  }
  return true;
}

/**
 * The lane a follow-up turn runs on, or null with the reason on the task's
 * feed (issue #172).
 *
 * The note is written at most once per stretch of failure: this is called from
 * a two-second poll, so an unfixed misconfiguration would otherwise bury the
 * conversation under thousands of identical lines. Comparing against the
 * latest message is enough — anything the owner or the agent says in between
 * makes the note current news again.
 */
function laneForFollowUp(
  taskId: string,
  kind: AgentPassKind,
  ticketModel: string | null
): PassLane | null {
  // A crossing the money guards refuse leaves the turn for a later poll with
  // the reason on the feed, exactly as a misconfigured lane does — the queued
  // message is still undelivered, so the owner's turn is not burnt and it runs
  // on the poll after the press (issue #173).
  const crossing = readLaneCrossing(kind);
  if (crossingHoldsPass(taskId, crossing)) return null;
  try {
    return requirePassLane(kind, ticketModel, crossing);
  } catch (err) {
    const text = `Cannot start this turn — ${err instanceof Error ? err.message : String(err)}`;
    if (noteOnceOnFeed(taskId, text)) {
      console.error(`[orchestrator] ${taskId}: ${text}`);
    }
    return null;
  }
}

/**
 * How long the recorder will wait for the daemon to say what an exec exited
 * with (issue #165). Deliberately *not* the shared `DOCKER_PROBE_TIMEOUT_MS`,
 * and shorter than it: every other bounded Docker probe in the fleet is
 * answering a question something decides on — admission, occupancy,
 * container existence — and can justify five seconds of patience. This one
 * fills in a field of a forensic log, on the completion path of every turn the
 * fleet runs, so it may not spend a decision's patience. A daemon too busy to
 * answer in a second leaves the field `null`, which the log already has a
 * meaning for.
 */
const EXIT_CODE_OBSERVATION_TIMEOUT_MS = 1000;

/**
 * Ask the daemon what a finished exec exited with, bounded and best-effort
 * (issue #165) — evidence for the passive recorder, never a decision input.
 *
 * Null covers both "still running" and "the daemon would not say", which is
 * honest: this is called the moment the turn settles, and `runTurn` deliberately
 * returns as soon as the terminal `result` event arrives rather than waiting for
 * the exec to close, because a background dev server can hold the stream open
 * long after Claude is done. Bounded for the usual #115/#128 reason — a hung
 * daemon connection has no timeout of its own — and nothing in the recorder's
 * path may stall a turn.
 */
async function observeExecExitCode(exec: {
  inspect: () => Promise<{ ExitCode?: number | null }>;
}): Promise<number | null> {
  const outcome = await runBoundedProbe(
    () => exec.inspect(),
    EXIT_CODE_OBSERVATION_TIMEOUT_MS
  );
  return outcome.ok ? (outcome.value.ExitCode ?? null) : null;
}

/**
 * Run a single agent turn and stream output to DB. With `captureRaw` the
 * raw stream is also returned — a review pass's verdict is parsed from it
 * after the turn ends.
 *
 * The command, the exec environment and the output handler all come from the
 * harness adapter the resolved lane names (issue #172), so this function is
 * the orchestration around a turn and knows nothing about the harness itself.
 *
 * The returned `costUsd` is what the turn is **charged** — the lane's own
 * prices applied to the reported token counts where the lane declares them,
 * and the harness's figure only where it does not (issue #175). Every caller
 * means "what did this turn cost", so the substitution happens once, here,
 * rather than at each budget check. The harness's own figure is not returned
 * beside it: it is written to the feed where a surprised operator will look
 * for it, and a second cost on this type would only invite a caller to charge
 * the wrong one.
 */
async function runTurn(
  taskId: string,
  running: RunningContainer,
  prompt: string,
  sessionId: string | undefined,
  opts: {
    lane: ResolvedLane;
    maxBudgetUsd?: number;
    maxTurns?: number;
    captureRaw?: boolean;
    effort?: string | null;
    isGenerationSession?: boolean;
  }
): Promise<TurnResult & { raw?: string }> {
  const adapter = getHarnessAdapter(opts.lane.adapter);
  const handler = adapter.createOutputHandler(taskId, opts.lane);
  const rawChunks: Buffer[] = [];

  // One fresh, short-lived App token per exec, serving both the git credential
  // helper and — for a generation session only (#62) — `gh`.
  const gitAuthToken = await getInstallationToken();

  const { stream, exec } = await execAgentTurn({
    container: running.container,
    command: adapter.buildCommand({
      sessionId,
      maxBudgetUsd: opts.maxBudgetUsd,
      maxTurns: opts.maxTurns,
      effort: opts.effort,
      lane: opts.lane,
    }),
    env: adapter.buildExecEnv({
      prompt,
      gitAuthToken,
      ghToken: opts.isGenerationSession ? gitAuthToken : null,
      lane: opts.lane,
    }),
  });

  // Race: wait for the exec stream to close OR the "result" event from Claude.
  // Background processes (e.g. dev servers) can keep the exec stream open
  // long after Claude exits, so the result event is the reliable signal.
  const resultReceived = new Promise<void>((resolve) => handler.onDone(resolve));

  const startedAtMs = Date.now();
  let result: TurnResult;
  try {
    await Promise.race([
      waitForExecStream(stream, exec, (chunk) => {
        handler.write(chunk);
        if (opts.captureRaw) rawChunks.push(chunk);
      }),
      resultReceived,
    ]);
  } finally {
    // How this pass ended, written down whether or not anyone is watching
    // (issue #165). In a `finally` because the exits worth the trouble are
    // exactly the ones that throw: `waitForExecStream` rejects on a stream
    // error, which is the shape of an OOM, a lost stream, or a container torn
    // down mid-turn — the last being what a rate-limit pause will deliberately
    // do. On the normal path the record still lands, capturing the other case
    // nothing else notices: a quota wall, which arrives looking like a
    // *successful* result and so leaves no trace in the task feed at all.
    result = handler.flush();
    // Read the clock before the probe below, not after: the probe may wait up
    // to its bound, and this duration is the measurement the "a rejected pass
    // exits in seconds rather than waiting" finding rests on.
    const durationMs = Date.now() - startedAtMs;
    getStreamRecorder().passExit(taskId, {
      resultArrived: result.terminalResult !== null,
      terminalResult: result.terminalResult,
      execExitCode: await observeExecExitCode(exec),
      durationMs,
    });
  }

  const charge = chargeForTurn(opts.lane, result);
  noteLaneCharge(taskId, opts.lane, charge);
  const charged = { ...result, costUsd: charge.usd };

  if (!opts.captureRaw) return charged;
  return { ...charged, raw: Buffer.concat(rawChunks).toString() };
}

/**
 * Say, once per turn, when the lane's price differs from the harness's claim
 * (issue #175).
 *
 * Not noise, and not a correction buried in the ledger: the feed's own "Turn
 * complete (cost: ...)" line carries the *harness's* figure, which on a lane
 * that declares prices is out by an order of magnitude or more (16.7x,
 * measured against OpenRouter). Leaving that line as the only thing an
 * operator sees would make a lane that is working look like one that is
 * bankrupting them — the exact conclusion the lane exists to disprove. Written
 * only when the two figures actually differ, so a lane on which they agree
 * stays silent.
 */
function noteLaneCharge(
  taskId: string,
  lane: ResolvedLane,
  charge: TurnCharge
): void {
  if (charge.basis !== "lane-prices") return;
  if (charge.usd.toFixed(4) === charge.reportedUsd.toFixed(4)) return;

  const factor = costOverstatement(charge);
  const comparison =
    factor === null ? "" : `, ${factor.toFixed(1)}x this lane's price`;
  // Deliberately says nothing about *why* the harness's figure differs: which
  // prices a harness computes against is the harness's business, and this
  // function sits in orchestration that names no vendor. The lane's declared
  // prices are the fleet's authority either way.
  insertSystemMessage(
    taskId,
    `Charged $${charge.usd.toFixed(4)} at lane prices on ${lane.label}` +
      ` (${lane.model ?? "harness default"}). The harness reported ` +
      `$${charge.reportedUsd.toFixed(4)}${comparison}, which is not this ` +
      `lane's price basis and is not what the fleet charges.`
  );
}

/**
 * Check for queued user messages and run follow-up turns.
 */
export async function processQueuedMessages(
  taskId: string,
  running: RunningContainer
): Promise<void> {
  const config = getConfig();

  // Resume a parked autonomous container (#93): it was docker-stopped to free
  // memory while awaiting its verdict or an answer. Restart it before running
  // the queued turn — but defer to a later poll if the box has no memory
  // headroom, leaving the message queued rather than overcommitting.
  if (!(await resumeParkedContainer(taskId, running))) return;

  while (true) {
    // Get current task state. A blocked implement pass is resumable — the
    // queued message is the answer to its question (issue #19).
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!task || (task.status !== "running" && task.status !== "blocked")) break;

    // Check budget — a run-owned task answers to its attempt budget, an
    // interactive task to the configured default. Budget exhaustion on a
    // run-owned task is a run-level outcome (issue #18): the attempt fails
    // through the ledger, because quietly completing the task here would
    // strand an undelivered fix-up message and leak the run in
    // `implementing` forever.
    const run = task.runId
      ? db.select().from(runs).where(eq(runs.id, task.runId)).get()
      : undefined;
    const budgetUsd = run?.budgetUsd ?? config.maxBudgetUsd;
    // The attempt's spend on this pass, not the row's: a pass resumed off a
    // quota pause carries what its predecessors spent (issue #169), so a
    // fix-up turn cannot re-open a budget the attempt has already used up. The
    // figure judged here is the *attempt's* budget for every run-owned task, a
    // repair pass included, so what carries is netted by the same rule
    // `resolvePassBudget` applies on the way in.
    const spentUsd = spendCarriedIntoPass(task) + (task.totalCostUsd ?? 0);
    if (spentUsd > 0 && spentUsd >= budgetUsd) {
      if (run) {
        await failImplementAttempt(
          taskId,
          run.id,
          `budget exhausted ($${spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)})`
        );
        break;
      }
      insertSystemMessage(
        taskId,
        `Budget limit reached ($${spentUsd.toFixed(2)} / $${budgetUsd.toFixed(2)})`
      );
      await completeTask(taskId);
      break;
    }

    // Resolve the lane before anything is consumed (issue #172). Fresh on
    // every follow-up turn, so a tier or lane changed mid-session applies from
    // the next one (issue #166) — and *before* the dequeue below, because a
    // failure after a message is marked delivered would burn the owner's turn
    // on a misconfiguration and strand the task non-terminal.
    //
    // Reported rather than thrown, unlike `startTask`'s. There is no failure
    // path to fall into here: the only caller is the poll loop's resume, whose
    // `.catch` logs to the console, so a throw would leave the task `running`
    // with its message queued and nothing on the feed while the loop retried
    // every two seconds forever — the "dies with Not logged in" failure this
    // ticket removes, re-created one layer up. Leaving the turn for a later
    // poll is right (the fix is an env var away, and the session is otherwise
    // healthy); saying so on the feed once is what was missing.
    const pass = laneForFollowUp(taskId, task.kind, run?.model ?? null);
    if (pass === null) break;
    const passLane = pass.lane;
    // A session walled mid-conversation crosses onto a paid lane at its next
    // turn, and the human reading the transcript is told — once, when the
    // payer changes (issue #173).
    announceCrossing(taskId, pass, {
      lane: task.lane,
      laneBilling: task.laneBilling,
    });
    // Re-recorded per turn, latest wins (issue #174). A session whose lane was
    // switched mid-flight has spent on both, and the task carries one figure;
    // attributing the lot to the lane it is on *now* is the direction that
    // fails safe, since over-reporting real money pauses pickup early while
    // under-reporting spends past the cap.
    updateTask(taskId, {
      lane: passLane.id,
      laneBilling: pass.billing,
      tier: passLane.tier ?? passLane.model,
    });

    // Find oldest undelivered user message
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

    if (!queued) {
      // No more queued messages — agent is idle. Interactive sessions get a
      // "your move" Discord ping; a parked implement pass just waits for the
      // sweep to re-evaluate its gates and queue the next review.
      if (task.kind === "interactive") await postIdleNotification(taskId);
      break;
    }

    // Mark as delivered. `updatedAt` is stamped with it because that column is
    // what the SSE stream re-emits an already-sent row on — without it the live
    // view would keep counting this message as queued for the rest of the
    // session (issue #122).
    const deliveredAt = new Date();
    db.update(messages)
      .set({ deliveredAt, updatedAt: deliveredAt })
      .where(eq(messages.id, queued.id))
      .run();

    // An answer un-parks a blocked run: it resumes implementing and the
    // reply becomes the next turn
    if (task.status === "blocked" && run) {
      db.update(runs)
        .set({ status: "implementing", blockedQuestion: null })
        .where(eq(runs.id, run.id))
        .run();
    }

    // Run next turn with the user message
    updateTask(taskId, { status: "running", containerStatus: "running" });
    setTaskState(taskId, "running");

    // Extract raw text from JSON content for the CLI prompt
    let promptText = queued.content;
    try {
      const parsed = JSON.parse(queued.content);
      if (parsed.text) promptText = parsed.text;
    } catch {
      // Plain text content — use as-is
    }

    // Follow-on slash routing (issue #63): in a generation session, a follow-up
    // message that leads with a known skill slash (the /to-spec → /to-tickets →
    // arm progression) is re-framed through the same seed-composition path, so
    // a typed slash carries the same framing (arming convention included) as the
    // seed turn and never degrades into the agent improvising the skill. A
    // non-slash message, or any message on a plain chat task, is untouched.
    if (task.sessionSkill) {
      promptText = composeSessionTurn(promptText);
    }

    // A follow-up turn on a run-owned task is capped at what remains of the
    // attempt budget, not the whole allowance again — the pre-turn check
    // above guarantees the remainder is positive here.
    const turnResult = await runTurn(
      taskId,
      running,
      promptText,
      task.sessionId ?? undefined,
      {
        maxBudgetUsd: run ? run.budgetUsd - spentUsd : undefined,
        maxTurns: run?.maxTurns ?? undefined,
        lane: passLane,
        effort: resolveAgentEffort(task.kind, config, run?.effort ?? null),
        // A generation session's follow-up exec gets a `gh` token too (#62).
        isGenerationSession: isGenerationSession(task),
      }
    );

    // Update cumulative cost and session
    const currentCost = task.totalCostUsd ?? 0;
    updateTask(taskId, {
      sessionId: turnResult.sessionId ?? task.sessionId,
      containerStatus: "idle",
      totalCostUsd: currentCost + turnResult.costUsd,
    });
    if (run) syncRunCost(run.id);
    setTaskState(taskId, "idle");

    // Commit and push after each turn
    await runPostTurnCommitAndPush(taskId, running);

    if (task.kind === "implement" || task.kind === "repair") {
      // A repair container that later receives a fix-up turn (issue #54) is
      // continuing the attempt's review cycle, so from here it behaves exactly
      // like an implement pass — exhaustion included.
      // Exhaustion first (issue #18): a fix-up or answer turn that spent the
      // attempt's remaining budget or turns fails the attempt through the
      // ledger — the branch is already pushed, the work survives.
      const exhaustion = run
        ? attemptExhaustion(run, spentUsd + turnResult.costUsd, turnResult.subtype)
        : null;
      if (exhaustion) {
        await failImplementAttempt(taskId, run!.id, exhaustion);
        break;
      }
      // Park-or-proceed again: the resumed pass may hit another unresolved
      // decision and re-park blocked, or end its turn healthy — which leaves
      // it parked awaiting review. A pass that blocked before its PR was
      // handed over (run.pullRequestNumber still unset) finishes like an
      // initial turn: PR marked ready, run recorded, or completed outright
      // when there is no PR. A reviewer's fix-up turn needs neither — its
      // new commits re-enter gate evaluation from the parked state.
      const decision = await evaluatePassOutcome(taskId, turnResult);
      if (decision !== "proceed") {
        // Anything but `proceed` means the pass was fully handled there and
        // this task is over: re-blocked mid-drain, its container stopped
        // (#93); failed as an empty pass, its container removed (#106);
        // refused by the account's quota and parked on the window's clock
        // (#168); or refused on a tier's allowance and retrying a rung lower
        // under a freshly queued pass (#170), its container removed. Draining
        // on would exec the next queued message into a stopped or removed
        // container, and falling through below would finish a pass that did
        // not finish.
        //
        // Written as "not proceed" rather than as a list of the outcomes,
        // deliberately: `proceed` is the only decision that leaves this loop
        // anything to do, so a decision added later stops the drain by
        // default — the safe direction, and the one a list got wrong when
        // #170 added its own.
        break;
      }
      if (!run?.pullRequestNumber) {
        // Blocked before its PR was handed over, now healthy: finish the pass.
        // With a PR this parks (stopping the container, #93); with none it
        // completes and the container is removed. Either way the pass has
        // ended this turn, so stop draining rather than exec the next message
        // into a stopped or removed container — a fresh resume delivers it.
        await finishImplementPass(taskId);
        break;
      }
      // Healthy fix-up on an already-handed-over PR: the container is still
      // running and the pass re-enters gate evaluation awaiting review. Drain
      // any further queued turn before the loop parks it below.
      continue;
    }

    if (task.kind === "interactive") await scanForDevServer(taskId, running);
  }

  // Re-park (#93): a resumed autonomous pass that ended its turn(s) still idle
  // (awaiting review again after a fix-up, or blocked on a fresh question)
  // keeps its container for the next turn — stop it again to free memory until
  // then. A no-op when the task completed, failed, or is interactive.
  await parkContainer(taskId);
}

/**
 * Complete a task: push final state, mark completed, cleanup.
 * Works even if activeTasks is empty (e.g. after server restart) by
 * reconnecting to the container via containerId from the database.
 */
export async function completeTask(taskId: string): Promise<void> {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) return;

  // Get container — prefer in-memory, fall back to DB containerId
  const entry = activeTasks.get(taskId);
  let running: RunningContainer | null = entry?.container ?? null;

  if (!running && task.containerId) {
    // Reconnect to container from DB
    try {
      const docker = getDocker();
      const container = docker.getContainer(task.containerId);
      await container.inspect(); // Verify it exists
      running = { container, id: task.containerId, name: task.containerName ?? "", previewSubdomain: task.previewSubdomain ?? "" };
    } catch {
      // Container no longer exists
    }
  } else if (running && (await observeContainerAbsent(running.name)) === true) {
    // A held handle is not proof the container is there. The DB path above
    // verifies with an `inspect` before trusting its id, and an in-memory entry
    // owes the same check — otherwise a session whose container died out of
    // band (a host OOM kill, a manual `docker rm`) fails its *completion*: the
    // push exec below throws and the catch marks the task `failed`, announcing
    // a failure for work the owner was closing normally. Dropping the handle
    // takes the graceful path instead, the one the doc comment above describes
    // (issue #159 — before `activeTasks` was shared, every UI-initiated
    // complete reached that path by accident, because the route could not see
    // the entry at all). Only a definitive absence drops it: on `null` — the
    // daemon did not answer — the handle is kept and the push is attempted, the
    // same benefit of the doubt this path has always given.
    running = null;
  }

  updateTask(taskId, { containerStatus: "completing" });
  if (entry) entry.state = "completing";

  try {
    if (running) {
      // A parked autonomous container is stopped to free memory (#93); a
      // complete triggered while parked (an owner action) must restart it
      // before the final push exec. A no-op for a live interactive container.
      await startContainer(running);
      await execFallbackCommitAndPush(running);
      insertSystemMessage(taskId, `Branch '${task.branch}' pushed.`);
    } else {
      insertSystemMessage(taskId, "Container no longer available — work was pushed after each turn.");
    }

    // Mark PR ready for review (any origin); comment on the issue only if there is one
    if (task.pullRequestNumber) {
      const proj = db.select().from(projects).where(eq(projects.id, task.projectId)).get();
      const repoRef = task.githubIssue
        ? parseIssueRef(task.githubIssue)
        : proj?.gitUrl
          ? parseRepoFromGitUrl(proj.gitUrl)
          : null;
      if (repoRef) {
        await markPrReady(repoRef.owner, repoRef.repo, task.pullRequestNumber);
        if (task.githubIssue) {
          const cost = (task.totalCostUsd ?? 0).toFixed(2);
          await commentOnIssue(
            task.githubIssue,
            `Complete -- PR #${task.pullRequestNumber} ready for review ($${cost})`
          );
        }
      }
    }

    updateTask(taskId, { status: "completed", containerStatus: null });
    if (task.runId) {
      syncRunCost(task.runId);
      const run = db.select().from(runs).where(eq(runs.id, task.runId)).get();
      db.update(runs)
        .set({
          pullRequestNumber: task.pullRequestNumber,
          pullRequestUrl: task.pullRequestUrl,
          // A run completed while parked on a question (e.g. budget cap hit
          // before its answer arrived) is no longer waiting on anyone: un-
          // block it so the ledger and the dashboard's needs-you stay
          // truthful, and the gate machinery picks its PR up from
          // `implementing`.
          ...(run?.status === "blocked"
            ? { status: "implementing" as const, blockedQuestion: null }
            : {}),
        })
        .where(eq(runs.id, task.runId))
        .run();
    }

    // Notify Discord — but not for autonomous passes: routine success is
    // deliberately silent, it belongs on the issue thread and the dashboard.
    const proj = db.select().from(projects).where(eq(projects.id, task.projectId)).get();
    if (proj?.discordChannelId && task.kind === "interactive") {
      notifyTaskCompleted(proj.discordChannelId, {
        id: taskId,
        title: task.title,
        totalCostUsd: task.totalCostUsd ?? 0,
        pullRequestUrl: task.pullRequestUrl ?? null,
      }).catch(console.error);
    }
  } catch (err) {
    insertSystemMessage(
      taskId,
      `Push failed: ${err instanceof Error ? err.message : String(err)}`
    );

    if (task.githubIssue) {
      const domain = process.env.DOMAIN ?? "interludes.co.uk";
      commentOnIssue(
        task.githubIssue,
        `Task failed -- check [Interlude](https://${domain}/tasks/${taskId}) for details`
      ).catch(console.error);
    }

    const projForNotify = db.select().from(projects).where(eq(projects.id, task.projectId)).get();
    if (projForNotify?.discordChannelId) {
      notifyTaskFailed(projForNotify.discordChannelId, {
        id: taskId,
        title: task.title,
        error: err instanceof Error ? err.message : String(err),
      }).catch(console.error);
    }

    updateTask(taskId, { status: "failed", containerStatus: null });
    if (task.runId) {
      finishRun(
        task.runId,
        "failed",
        `container error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } finally {
    activeTasks.delete(taskId);
    if (running && !getConfig().keepContainers) {
      await removeContainer(running);
      updateTask(taskId, { containerId: null });
    }
  }
}

/**
 * End of an implement pass's initial turn: the branch is pushed and the
 * draft PR (if any) exists. Mark the PR ready, record it on the run, and
 * park the container — task stays `running`/idle so the existing message
 * queue can deliver a reviewer's fix-up turn into the same attempt. With no
 * PR there is nothing to review; fall back to completing the task outright.
 */
async function finishImplementPass(taskId: string): Promise<void> {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) return;

  if (!task.pullRequestNumber) {
    console.log(`[orchestrator] Implement pass ${taskId} produced no PR — completing task`);
    await completeTask(taskId);
    return;
  }

  const repoRef = task.githubIssue ? parseIssueRef(task.githubIssue) : null;
  if (repoRef) {
    await markPrReady(repoRef.owner, repoRef.repo, task.pullRequestNumber);
  }

  if (task.runId) {
    db.update(runs)
      .set({
        pullRequestNumber: task.pullRequestNumber,
        pullRequestUrl: task.pullRequestUrl,
      })
      .where(eq(runs.id, task.runId))
      .run();
  }

  insertSystemMessage(
    taskId,
    `Implement pass complete — PR #${task.pullRequestNumber} marked ready. Awaiting review.`
  );
  if (task.githubIssue) {
    const cost = (task.totalCostUsd ?? 0).toFixed(2);
    await commentOnIssue(
      task.githubIssue,
      `Implement pass complete -- PR #${task.pullRequestNumber} ready for review ($${cost})`
    );
  }

  // The pass is now parked awaiting its review verdict — stop the container to
  // free its memory until a fix-up turn (or its release) arrives (issue #93).
  await parkContainer(taskId);
}

/**
 * Why an implement pass's turn left its attempt unable to continue, or null
 * for a healthy turn. Budget is judged from accumulated cost (robust to CLI
 * versions), turn exhaustion from the result event's subtype.
 */
function attemptExhaustion(
  run: { budgetUsd: number },
  totalCostUsd: number,
  turnSubtype: string | null
): string | null {
  if (totalCostUsd >= run.budgetUsd) {
    return `budget exhausted ($${totalCostUsd.toFixed(2)} of $${run.budgetUsd.toFixed(2)})`;
  }
  if (turnSubtype === "error_max_turns") return "turn limit reached";
  return null;
}

/**
 * Fail an implement attempt through the run ledger (issue #18): the run
 * records the strike and its reason, the task fails, the owner learns why on
 * the issue, and the container goes away. The branch was pushed after the
 * turn, so the work survives for the next attempt; three strikes and the
 * sweep routes the ticket back to a human.
 */
async function failImplementAttempt(
  taskId: string,
  runId: string,
  reason: string
): Promise<void> {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();

  // Take the container handle before the status goes terminal. From that write
  // on, the queue's poll is entitled to drop the session entry (issue #159) —
  // and the issue comment below is awaited, so a 2s poll fits comfortably
  // inside the gap. Reading the map afterwards would find nothing and leak a
  // ~2 GiB container until the 5-minute reaper caught it, on exactly the box
  // that OOM-wedged on 2026-08-19.
  const container = activeTasks.get(taskId)?.container ?? null;

  insertSystemMessage(taskId, `Attempt failed: ${reason}`);
  updateTask(taskId, { status: "failed", containerStatus: null });
  syncRunCost(runId);
  db.update(runs)
    .set({
      status: "failed",
      failureReason: reason,
      finishedAt: new Date(),
      // Keep the PR on the ledger for the exhaust summary and dashboard
      pullRequestNumber: task?.pullRequestNumber ?? run?.pullRequestNumber,
      pullRequestUrl: task?.pullRequestUrl ?? run?.pullRequestUrl,
      // A blocked run that dies exhausted is no longer waiting on anyone
      blockedQuestion: null,
    })
    .where(eq(runs.id, runId))
    .run();

  if (task?.githubIssue) {
    await commentOnIssue(
      task.githubIssue,
      `Run failed (attempt ${run?.attempt ?? "?"}/${MAX_ATTEMPTS}): ${reason}. ` +
        `Work so far is pushed to \`${task.branch}\`.`
    );
  }

  await removeTaskContainer(taskId, container);
}

/**
 * Interrupt an implement pass whose container died before finishing (issue
 * #97): a mid-turn OOM / docker error / lost stream, not a failed attempt. The
 * run is marked `interrupted` (bumping the interruption count, never a strike),
 * the task fails, the owner learns why on the issue, and the container goes
 * away. The branch was pushed after every turn, so any work survives for the
 * re-claim the sweep queues without consuming an attempt. Mirrors
 * `failImplementAttempt` but routes to the interruption bound (issue #24)
 * rather than the attempt budget.
 */
async function interruptImplementPass(
  taskId: string,
  runId: string,
  reason: string
): Promise<void> {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();

  insertSystemMessage(taskId, `Pass interrupted: ${reason}`);
  updateTask(taskId, { status: "failed", containerStatus: null });
  syncRunCost(runId);
  interruptRun(runId, reason);

  if (task?.githubIssue) {
    // Fire-and-forget: one call site awaits this from inside startTask's try,
    // so a rejected comment must not throw back into the catch and re-run the
    // whole interruption (a duplicate comment, a second count bump).
    commentOnIssue(
      task.githubIssue,
      `Run interrupted (attempt ${run?.attempt ?? "?"}): ${reason}. ` +
        `Container deaths don't consume an attempt — the sweep re-claims this ` +
        `ticket (bounded). Work so far is pushed to \`${task.branch}\`.`
    ).catch(console.error);
  }

  await removeTaskContainer(taskId, activeTasks.get(taskId)?.container ?? null);
}

/**
 * End of a review pass: parse the verdict from the raw stream, store it on
 * the run for the sweep's next decision, and tear the container down. A
 * review pass never pushes, opens PRs, or posts anything itself.
 */
async function finishReviewPass(
  taskId: string,
  running: RunningContainer,
  runId: string | null,
  rawStream: string
): Promise<void> {
  const verdict = parseReviewVerdict(rawStream);

  // An unparseable verdict with no terminal result event in the stream is an
  // infra death (issue #97): the container exited mid-review (OOM / docker
  // error / lost stream), it did not merely mis-format a real review. Storing
  // it as an unparseable verdict would burn the one bounded format-retry meant
  // for genuine format slips (issue #89). Instead mark the pass `failed` and
  // leave the verdict unstored, so the sweep queues a fresh replacement review
  // — the same recovery the #95 reaper gives a hung review container, consuming
  // no retry. The `running`-status guard mirrors the store below: a pass the
  // sweep already reaped and replaced (#95) must not be touched again.
  if (verdict.kind === "unparseable" && !passProducedResult(rawStream)) {
    if (storedTaskStatus(taskId) === "running") {
      updateTask(taskId, { status: "failed", containerStatus: null });
      insertSystemMessage(
        taskId,
        `Review pass produced no result event (container died mid-review): ` +
          `${verdict.reason}. Marking it failed so a replacement review is ` +
          `queued — no format-retry consumed.`
      );
    }
    console.log(
      `[orchestrator] Review task ${taskId} died without a result event — ` +
        `replacement will be queued (issue #97)`
    );
    await removeTaskContainer(taskId, running);
    return;
  }

  // Only store the verdict if this pass is still the run's live review. If the
  // sweep reaped it as dead (container gone, task no longer `running` — issue
  // #95) while its turn was hung, a replacement review may already be in
  // flight; writing this pass's verdict now would clobber it.
  if (runId && storedTaskStatus(taskId) === "running") {
    db.update(runs).set({ reviewResult: verdict }).where(eq(runs.id, runId)).run();
  }

  insertSystemMessage(
    taskId,
    verdict.kind === "unparseable"
      ? `Review pass finished without a parseable verdict: ${verdict.reason}`
      : `Review pass verdict: ${verdict.kind}`
  );
  console.log(`[orchestrator] Review task ${taskId} verdict: ${verdict.kind}`);

  await teardownTaskContainer(taskId, running);
}

/**
 * End of a triage pass: parse the exit from the raw stream, store it on the
 * task for the sweep's next decision, and tear the container down. A triage
 * pass never pushes, labels, comments or posts anything itself.
 */
async function finishTriagePass(
  taskId: string,
  running: RunningContainer,
  rawStream: string
): Promise<void> {
  const exit = parseTriageExit(rawStream);

  updateTask(taskId, { triageResult: exit });

  insertSystemMessage(
    taskId,
    exit.kind === "unparseable"
      ? `Triage pass finished without a parseable exit: ${exit.reason}`
      : `Triage pass exit: ${exit.kind}`
  );
  console.log(`[orchestrator] Triage task ${taskId} exit: ${exit.kind}`);

  await teardownTaskContainer(taskId, running);
}

/**
 * Release a parked implement container once its verdict needs no further
 * turns (approve, escalate, or the PR settled). The branch was pushed after
 * every turn, so there is nothing left to save — just record completion and
 * remove the container. Called by the autonomy sweep.
 */
export async function releaseParkedImplementTask(taskId: string, note: string): Promise<void> {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task || task.status !== "running") return;

  insertSystemMessage(taskId, note);
  await teardownTaskContainer(taskId, activeTasks.get(taskId)?.container ?? null);
}

/**
 * Drop a task's in-memory session entry and remove its container (unless kept
 * for debugging). The shared teardown behind every terminal path — completion,
 * a failed attempt, an interruption, a reaped review — that must not leave a
 * dead container holding memory or a phantom slot. The caller has already set
 * the task's terminal status; this only lets go of the container.
 */
async function removeTaskContainer(
  taskId: string,
  running: RunningContainer | null
): Promise<void> {
  activeTasks.delete(taskId);
  if (running && !getConfig().keepContainers) {
    await removeContainer(running);
    updateTask(taskId, { containerId: null });
  }
}

/** Record completion and remove the container (unless kept for debugging). */
async function teardownTaskContainer(
  taskId: string,
  running: RunningContainer | null
): Promise<void> {
  updateTask(taskId, { status: "completed", containerStatus: null });
  await removeTaskContainer(taskId, running);
}

/** A run's spend is the sum over the tasks it owns — implement pass plus
 * any review passes — so budgets and the daily cap see review spend too. */
function syncRunCost(runId: string): void {
  const owned = db.select().from(tasks).where(eq(tasks.runId, runId)).all();
  const total = owned.reduce((sum, t) => sum + (t.totalCostUsd ?? 0), 0);
  db.update(runs).set({ totalCostUsd: total }).where(eq(runs.id, runId)).run();
}

/**
 * The turn's final message: the most recent agent text message of the task.
 * Null when the turn produced no text at all.
 */
function lastAgentTextMessage(taskId: string): string | null {
  const lastAgent = db
    .select()
    .from(messages)
    .where(and(eq(messages.taskId, taskId), eq(messages.role, "agent"), eq(messages.type, "text")))
    .orderBy(desc(messages.createdAt))
    .get();

  if (!lastAgent) return null;
  try {
    const parsed = JSON.parse(lastAgent.content);
    return typeof parsed.text === "string" ? parsed.text : lastAgent.content;
  } catch {
    return lastAgent.content;
  }
}

/**
 * What the reducer decided about an implement pass whose turn just ended:
 * - `degraded`  — a tier's allowance refused the pass, so the run steps down
 *                 the ladder and a fresh pass is queued (issue #170)
 * - `paused`    — the account's quota refused the pass, so the run waits on the
 *                 window's reset; container torn down (issue #168)
 * - `blocked`   — parked on a question (issue #19); container preserved (#93)
 * - `finalized` — no PR and no question, so the run was failed to a terminal
 *                 status rather than left dangling (issue #106)
 * - `proceed`   — healthy; the caller finishes the pass (park awaiting review,
 *                 or complete the task when there is a PR to hand over)
 *
 * Everything but `proceed` is fully handled inside `evaluatePassOutcome`; only
 * `proceed` leaves anything for the caller.
 */
type PassDecision = "blocked" | "degraded" | "finalized" | "paused" | "proceed";

/**
 * Park-or-proceed for an implement pass whose turn just ended (issue #19):
 * ask the reducer about the turn's result — this turn's, never an earlier
 * turn's re-read — and the PR the pass left (if any). Rate-limited — park the
 * run on the quota window's clock, consuming no attempt (issue #168). Blocked
 * — park the run (its container stopped to free memory but preserved, #93) and
 * post the question. Empty (no PR, no question) — fail the attempt so the run
 * reaches a terminal status (issue #106). Otherwise the caller proceeds.
 *
 * The whole turn result is passed, not just its final message, because the
 * quota wall is only legible from the terminal event and the rate-limit event
 * together — and by design the reducer, not this function, decides which of
 * the three readings wins.
 *
 * Exported as the seam it is: this is where a finished turn becomes a ledger
 * outcome, and it is the only honest entry point for a test that wants to
 * assert what a walled or blocked turn does to the run row without
 * provisioning a container to produce one.
 */
export async function evaluatePassOutcome(
  taskId: string,
  turn: Pick<TurnResult, "finalMessage"> & TurnQuotaSignals
): Promise<PassDecision> {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task?.runId || !task.githubIssue) return "proceed";
  const run = db.select().from(runs).where(eq(runs.id, task.runId)).get();

  // Only a genuine implement pass can be "empty" in the #106 sense: a repair
  // pass (issue #54) always operates on an existing PR and is never an
  // attempt, so it must never be finalized here — report producedPr = true for
  // it whatever the task row carries.
  const producedPr =
    task.kind !== "implement" || task.pullRequestNumber != null;

  const actions = decideNext(
    passOutcomeSnapshot(new Date(), {
      runId: task.runId,
      taskId,
      issueRef: task.githubIssue,
      finalMessage: turn.finalMessage,
      producedPr,
      // Read from this turn's own result, at the one seam that has it: whether
      // the account refused the pass is not recoverable from the task row
      // afterwards (issue #168).
      rateLimited: detectQuotaRejection(turn),
      // The ladder's starting rung (issue #170). `runs.model` is where the tier
      // a pass ran at is recorded — written when the implement pass starts —
      // and it is read back through the same normaliser every other reader of
      // that column uses, so a legacy alias resolves and a pinned raw model id
      // arrives as the null it is.
      tier: normalizeModelTier(run?.model ?? null),
    })
  );

  for (const action of actions) {
    if (action.type === "degradeRunTier") {
      await degradeRunTier(action, task);
      return "degraded";
    }
    if (action.type === "pauseRunOnRateLimit") {
      await pauseRunOnRateLimit(action);
      return "paused";
    }
    if (action.type === "escalate" && action.reason === "blocked") {
      await parkBlockedRun(taskId, action.runId, action.question);
      return "blocked";
    }
    if (action.type === "finalizeEmptyPass") {
      // Nothing to review or merge — finalize the run as a failed attempt so it
      // reaches a terminal status instead of dangling as a ghost `running`
      // card (issue #106). The branch was pushed after the turn, so any work
      // survives for the next attempt.
      await failImplementAttempt(
        taskId,
        action.runId,
        "implement pass produced no PR and no BLOCKED question"
      );
      return "finalized";
    }
  }
  return "proceed";
}

/**
 * Step a run down the tier ladder and retry it (issue #170).
 *
 * The account still has quota — just not for the tier this pass asked for — so
 * stopping the run would be leaving work on the table for up to seven days.
 * Instead the refused pass ends, the run records the tier it is dropping to,
 * and a fresh pass of the **same kind** is queued under the same run: an
 * implement pass retries as an implement pass, a repair as a repair, carrying
 * the same prompt, branch and PR. The queue picks it up on the next poll like
 * any other queued task, and `startTask` resolves the lane through
 * `runs.model`, which is where the new tier now sits.
 *
 * Nothing is charged for it, for the same reason a pause charges nothing: the
 * work was never tried. Neither `attempt` nor `interruptionCount` moves, and
 * the run's status is deliberately left exactly as it was — a degraded
 * implement pass leaves the run `implementing` with a queued task, which is a
 * state the sweep already reads correctly (its gate evaluation waits on a
 * settled working pass, and a queued one is not settled).
 *
 * The ladder bounds itself: `runs.model` only ever moves downward, so a run can
 * degrade at most twice before it is at the bottom and the next wall pauses it.
 *
 * `degradedFrom` is written **once** — the first step's `from` — so the ledger
 * keeps the tier the run was asked to run at, however far down it has since
 * walked. Rewriting it on every step would make a heavy run that reached light
 * read as a standard one that slipped a rung.
 *
 * The ending itself — the ordering, the teardown, the two counters left alone —
 * is `endRefusedPass`'s, which is also what guarantees the retry is durably
 * queued before the refused pass's container goes.
 */
/**
 * The ordering every refused pass ends on, written once (issues #168, #170).
 *
 * A quota wall has two possible consequences — park the run on the window's
 * clock, or step it down a tier and retry — and they differ only in what the
 * run records and what is queued behind them. What they must *not* differ in is
 * this sequence, every step of which is load-bearing:
 *
 *  - the container handle is taken **before** the task's status goes terminal:
 *    from that write on the queue's poll may drop the session entry (issue
 *    #159), and reading the map afterwards would leak the container until the
 *    5-minute reaper caught it;
 *  - the session transcript is copied out **before** the teardown and before
 *    anything terminal is written (issue #169), because the conversation only
 *    exists inside the container that is about to go. Best-effort by design:
 *    an ending protects the ticket's attempt, and keeping the conversation
 *    only saves its successor some re-orientation, so a transcript that cannot
 *    be copied must never cost the ending itself;
 *  - the task is failed for the same reason an interrupted pass's is — its exec
 *    is over and its container is going, so leaving it live would hold a slot
 *    against a run that is doing nothing. The *run*, not the task, is what
 *    carries the outcome;
 *  - neither `attempt` nor `interruptionCount` is touched anywhere here, which
 *    is the whole point of both states: the work was never tried, so the bounds
 *    keep measuring what they say they measure. `runPatch` is the only thing
 *    written to the run, so a caller cannot quietly spend one;
 *  - `queueNext` runs before the teardown, so whatever replaces this pass is
 *    durable before its container goes — a crash between the two would
 *    otherwise leave a run with no live work for boot to finalize as a ghost;
 *  - the teardown is **removal**, not the stop a blocked run gets (#93): a
 *    parked container holds ~2 GiB while holding no slot, which is how the box
 *    OOM-wedged on 2026-08-04, and neither of these outcomes comes back to the
 *    same container. The branch was pushed after the turn, so nothing is lost.
 */
async function endRefusedPass(args: {
  taskId: string;
  runId: string;
  /** The refused pass's session, copied out of the container before it goes so
   *  whatever takes this pass's place can continue the same conversation
   *  (issue #169). Null when there is no session, or when the successor is not
   *  a continuation of this pass. */
  sessionId?: string | null;
  /** Said on the task's own feed, in place of a failure. Takes whether the
   *  conversation survived the teardown, which only this knows. */
  note: (preserved: boolean) => string;
  /** What the run records instead of a spent attempt */
  runPatch: Partial<typeof runs.$inferInsert>;
  /** The pass queued to take this one's place, if any */
  queueNext?: () => void;
}): Promise<boolean> {
  const container = activeTasks.get(args.taskId)?.container ?? null;

  // Before the teardown, and before anything terminal is written: the
  // conversation only exists inside the container that is about to go (issue
  // #169). Its failure is reported, never fatal — the ending protects the
  // attempt whether or not the context survives.
  const preserved = await preserveSessionTranscript(
    args.runId,
    args.sessionId ?? null,
    container
  );

  insertSystemMessage(args.taskId, args.note(preserved));
  updateTask(args.taskId, { status: "failed", containerStatus: null });
  syncRunCost(args.runId);
  db.update(runs).set(args.runPatch).where(eq(runs.id, args.runId)).run();
  args.queueNext?.();

  await removeTaskContainer(args.taskId, container);
  return preserved;
}

async function degradeRunTier(
  step: Extract<Action, { type: "degradeRunTier" }>,
  task: typeof tasks.$inferSelect
): Promise<void> {
  const run = db.select().from(runs).where(eq(runs.id, step.runId)).get();

  const window = `the ${describeRateLimitType(step.limitType)} allowance`;
  const resets = step.resumeAfter
    ? ` (it resets at ${step.resumeAfter.toUTCString()})`
    : "";
  const retryId = newId();

  console.log(
    `[autonomy] Run ${step.runId} (${run?.githubIssue ?? "?"}) stepping down ` +
      `${step.from} -> ${step.to} on ${step.limitType} — retrying as task ` +
      `${retryId}, no attempt consumed`
  );

  if (task.githubIssue) {
    // Fire-and-forget, as the pause path's comment is: one call site awaits
    // this from inside startTask's try, and a rejected comment must not throw
    // back into the catch and re-run the whole step.
    commentOnIssue(
      task.githubIssue,
      `Stepped down a model tier (attempt ${run?.attempt ?? "?"}): ${window} ` +
        `refused this pass${resets}, so the run continues at \`${step.to}\` ` +
        `instead of \`${step.from}\` rather than waiting the window out. ` +
        `A tier step consumes neither an attempt nor an interruption — ` +
        `work so far is pushed to \`${task.branch}\`.`
    ).catch(console.error);
  }

  await endRefusedPass({
    taskId: step.taskId,
    runId: step.runId,
    // Deliberately no session: the retry starts a fresh conversation at the
    // lower tier, on the same branch with the work pushed. Continuing the
    // refused pass's session is the *resume* path's promise (issue #169),
    // where the pass that continues is the same pass on the same tier.
    note: () =>
      `Stepping down from the ${step.from} tier to ${step.to} — ${window} ` +
      `refused this pass${resets}. The run retries at ${step.to}; ` +
      `no attempt or interruption was consumed.`,
    runPatch: {
      model: step.to,
      // Only the first step records where the run started; a second step is
      // still a run that was asked for `from` of the first. Nothing ever puts
      // it back: a run that lost its tier keeps the lower one for the rest of
      // the attempt, even past the window's reset, because the alternative is
      // re-testing the wall with an agent turn on every later pass.
      degradedFrom: run?.degradedFrom ?? step.from,
      // Deliberately not `status`: the run carries on. An implement pass leaves
      // it `implementing` with a queued task, which the sweep already reads
      // correctly (a queued pass is not a settled one, so gate evaluation
      // waits), and boot leaves it alone because it still owns live work.
    },
    queueNext: () =>
      db
        .insert(tasks)
        .values({
          id: retryId,
          projectId: task.projectId,
          title: task.title,
          // The same prompt, verbatim: the work has not changed, only the tier
          // it runs on. A repair pass's PR context rides along for the same
          // reason — a repair degrades as a repair.
          description: task.description,
          status: "queued",
          kind: task.kind,
          runId: step.runId,
          githubIssue: task.githubIssue,
          branch: task.branch,
          // Lineage, and with it the attempt's budget (issues #169, #170): a
          // degraded retry is a *second* implement-shaped task under the same
          // run, and every budget control is scoped to the task row, so
          // without this the turn manager would hand it the whole per-attempt
          // allowance again on top of whatever the refused pass spent. A
          // refused pass usually spends ~nothing, but a wall hit deep into a
          // long turn does not, and one attempt must not cost two budgets.
          resumedFromTaskId: task.id,
          pullRequestNumber: task.pullRequestNumber,
          pullRequestUrl: task.pullRequestUrl,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .run(),
  });
}

/**
 * Park a run the account's quota refused (issue #168).
 *
 * A quota wall is not a failure of the work, so nothing here counts against
 * the ticket: the run goes `rate_limited` carrying the window's reset time,
 * and neither `attempt` (which measures how hard the work was) nor
 * `interruptionCount` (which measures orchestrator restarts) moves. Both
 * bounds keep meaning what they say — that is the whole point of the state.
 *
 * The ending itself — the ordering, the teardown, the two counters left alone —
 * is `endRefusedPass`'s; what is here is only what a *pause* records and says.
 * The run, not the task, is what is paused, and the run is where the resume
 * will be decided.
 */
async function pauseRunOnRateLimit(
  pause: Extract<Action, { type: "pauseRunOnRateLimit" }>
): Promise<void> {
  const taskId = pause.taskId;
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  const run = db.select().from(runs).where(eq(runs.id, pause.runId)).get();

  const window = pause.limitType
    ? `the ${describeRateLimitType(pause.limitType)}`
    : "the account's rate limit";
  // Said as a wall-clock instant rather than an ISO stamp: these two lines are
  // read by a human on an issue thread, and the dashboard is where the live
  // countdown lives.
  const resumes = pause.resumeAfter.toUTCString();

  console.log(
    `[autonomy] Run ${pause.runId} (${run?.githubIssue ?? "?"}) paused on ` +
      `${window} until ${resumes} — no attempt consumed`
  );

  // The paused pass's conversation is copied out on the way through: nothing
  // takes this pass's place here — a paused run waits on a clock — but the
  // sweep's resume (issue #169) continues the same session when it survived.
  const preserved = await endRefusedPass({
    taskId,
    runId: pause.runId,
    sessionId: task?.sessionId ?? null,
    note: (kept) =>
      `Paused on ${window} — the account's quota refused this pass. ` +
      `The window resets at ${resumes}; no attempt or interruption was consumed.` +
      (kept
        ? " The session was copied out, so the resume continues this conversation."
        : " The session could not be copied out, so the resume will start again" +
          " on the same branch."),
    runPatch: {
      status: "rate_limited",
      resumeAfter: pause.resumeAfter,
      // Deliberately not finishedAt: the run has not finished. It is waiting.
    },
  });

  if (task?.githubIssue) {
    // Fire-and-forget, as the interruption path's comment is: one call site
    // awaits this from inside startTask's try, and a rejected comment must not
    // throw back into the catch and re-run the whole pause.
    commentOnIssue(
      task.githubIssue,
      `Run paused (attempt ${run?.attempt ?? "?"}): the account's quota ` +
        `refused this pass on ${window}. The window resets at ${resumes}, when ` +
        `the run resumes by itself. A quota pause consumes neither an attempt ` +
        `nor an interruption — work so far is pushed to \`${task.branch}\`` +
        `${preserved ? ", and the pass resumes the same conversation" : ""}.`
    ).catch(console.error);
  }
}

/**
 * Park a blocked run: the run and task go `blocked`, the container is stopped
 * to free its memory but preserved (its filesystem and branch state survive a
 * restart in ~1s, #93), and the question is posted to the project's linked
 * Discord channel — or the fleet channel when the project has none, so no
 * question is silently lost. The posted message becomes the task's interactive
 * message: a reply to it restarts the container and queues the answer as the
 * next turn.
 */
async function parkBlockedRun(taskId: string, runId: string, question: string): Promise<void> {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) return;

  db.update(runs)
    .set({ status: "blocked", blockedQuestion: question })
    .where(eq(runs.id, runId))
    .run();
  updateTask(taskId, { status: "blocked" });
  insertSystemMessage(taskId, `Run blocked — waiting for an answer: ${question}`);
  console.log(`[autonomy] Run ${runId} blocked on: ${question}`);

  // Parked on the owner's answer — stop the container to free its memory until
  // the reply lands as the next turn (issue #93). The question below is posted
  // out-of-band (Discord + the task chat), so nothing needs the container now.
  await parkContainer(taskId);

  const proj = db.select().from(projects).where(eq(projects.id, task.projectId)).get();
  const channelId = proj?.discordChannelId ?? getConfig().discordFleetChannelId;
  if (!channelId) {
    console.warn(
      `[autonomy] Run ${runId} is blocked but no project or fleet Discord channel is ` +
        `configured — the question waits on the dashboard and in the task chat`
    );
    return;
  }

  const msgId = await notifyRunBlocked(channelId, {
    id: taskId,
    title: task.title,
    question,
    issueRef: task.githubIssue,
    projectName: proj?.name ?? null,
  });
  if (msgId) updateTask(taskId, { discordMessageId: msgId });
}

/**
 * Cancel a task: stop container, cleanup.
 *
 * Records `cancelled` *before* touching the container, because killing it ends
 * the turn running inside it and that turn's own error handling then races this
 * one: it would write `failed` and `finishRun(runId, "failed")` over the
 * owner's cancellation, burning one of MAX_ATTEMPTS on a run nobody's work
 * failed. Writing the status first makes the loser of that race a no-op —
 * `startTask`'s catch returns early once its task is already terminal (issue
 * #159). Before `activeTasks` was shared this ordering was unreachable from the
 * UI, because the route's copy of the map never held the entry.
 */
export async function cancelTask(taskId: string): Promise<void> {
  const entry = activeTasks.get(taskId);

  updateTask(taskId, {
    status: "cancelled",
    containerId: null,
    containerStatus: null,
  });
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  // Owner-cancelled runs don't consume an attempt: cancelled is not failed
  if (task?.runId) finishRun(task.runId, "cancelled");
  insertSystemMessage(taskId, "Task cancelled by user.");

  if (entry) {
    activeTasks.delete(taskId);
    await stopContainer(entry.container);
    await removeContainer(entry.container);
  }
}

/**
 * Scan for dev server ports after a turn completes.
 * Retries once after 3s if no ports found (dev server may be starting).
 */
export async function scanForDevServer(taskId: string, running: RunningContainer): Promise<void> {
  let ports = await scanPorts(running);

  if (ports.length === 0) {
    await new Promise((r) => setTimeout(r, 3000));
    ports = await scanPorts(running);
  }

  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) return;

  const newPort = ports.length > 0 ? ports[0] : null;
  const currentPort = task.devPort ?? null;

  if (newPort !== currentPort) {
    updateTask(taskId, { devPort: newPort });
    if (newPort && !currentPort) {
      insertSystemMessage(taskId, `Dev server detected on port ${newPort}`);
    } else if (!newPort && currentPort) {
      insertSystemMessage(taskId, `Dev server on port ${currentPort} stopped`);
    }
  }
}

/**
 * Post an "agent finished a turn" idle notification to the project's Discord
 * channel (if linked) and store the message id as the task's current
 * interactive message. Fire-and-forget safe: never throws to the caller.
 */
async function postIdleNotification(taskId: string): Promise<void> {
  try {
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!task) return;
    const proj = db.select().from(projects).where(eq(projects.id, task.projectId)).get();
    if (!proj?.discordChannelId) return;

    const summary = lastAgentTextMessage(taskId) ?? "";

    const msgId = await notifyTaskIdle(proj.discordChannelId, {
      id: taskId,
      title: task.title,
      summary,
      branch: task.branch ?? "",
    });
    if (msgId) updateTask(taskId, { discordMessageId: msgId });
  } catch (err) {
    console.error(`[discord] postIdleNotification failed:`, err);
  }
}

/**
 * After each turn, commit any uncommitted changes and push the branch.
 * This ensures work is always available on GitHub for PRs.
 */
async function runPostTurnCommitAndPush(taskId: string, running: RunningContainer): Promise<void> {
  try {
    const { commitsAhead } = await execFallbackCommitAndPush(running);
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    insertSystemMessage(taskId, `Branch '${task?.branch}' pushed.`);

    // Create draft PR on first push if none exists yet (any task origin) — but
    // never for a branch level with its base, which GitHub cannot open a PR for
    // (issue #151): a grilling session commits nothing, so it would re-attempt
    // that doomed call every turn.
    if (task && task.branch && shouldOpenDraftPr({ existingPr: task.pullRequestNumber, commitsAhead })) {
      const proj = db.select().from(projects).where(eq(projects.id, task.projectId)).get();
      const repoRef = task.githubIssue
        ? parseIssueRef(task.githubIssue)
        : proj?.gitUrl
          ? parseRepoFromGitUrl(proj.gitUrl)
          : null;

      if (repoRef) {
        const domain = process.env.DOMAIN ?? "interludes.co.uk";
        const issueLine = task.githubIssue ? `Closes #${(repoRef as { number?: number }).number}\n\n` : "";
        const body = `${issueLine}[View in Interlude](https://${domain}/tasks/${taskId})`;

        const pr = await createDraftPr({
          owner: repoRef.owner,
          repo: repoRef.repo,
          title: task.title,
          head: task.branch,
          body,
        });

        if (pr) {
          updateTask(taskId, {
            pullRequestNumber: pr.number,
            pullRequestUrl: pr.url,
          });
          // On a retry that adopted a previous attempt's PR (#72) the issue
          // already carries its "opened" comment — don't post a duplicate;
          // finishImplementPass will announce it "ready for review".
          if (task.githubIssue && !pr.adopted) {
            await commentOnIssue(task.githubIssue, `Draft PR opened: #${pr.number}`);
          }
          console.log(
            `[github] Draft PR #${pr.number} ${pr.adopted ? "adopted" : "created"} for task ${taskId}`
          );
        }
      }
    }
  } catch (err) {
    insertSystemMessage(
      taskId,
      `Push warning: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Wait for a Docker exec stream to complete, with polling fallback.
 * Docker exec streams sometimes don't emit "end" after the process exits.
 */
async function waitForExecStream(
  stream: NodeJS.ReadableStream,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exec: any,
  onData?: (chunk: Buffer) => void
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let resolved = false;
    let poll: ReturnType<typeof setInterval> | null = null;

    const done = () => {
      if (resolved) return;
      resolved = true;
      if (poll) clearInterval(poll);
      resolve();
    };

    if (onData) {
      stream.on("data", (chunk: Buffer) => {
        onData(chunk);
      });
    } else {
      stream.resume();
    }
    stream.on("end", done);
    stream.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      if (poll) clearInterval(poll);
      reject(err);
    });

    // Fallback: poll exec status every 2s
    poll = setInterval(async () => {
      try {
        const info = await exec.inspect();
        if (!info.Running) {
          setTimeout(done, 500);
        }
      } catch {
        done();
      }
    }, 2000);
  });
}

function updateTask(
  taskId: string,
  fields: Partial<{
    status: "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled";
    branch: string;
    containerId: string | null;
    containerName: string | null;
    containerStatus: "setup" | "running" | "idle" | "completing" | null;
    sessionId: string | null;
    totalCostUsd: number;
    devPort: number | null;
    previewSubdomain: string | null;
    pullRequestNumber: number | null;
    pullRequestUrl: string | null;
    discordMessageId: string | null;
    triageResult: (typeof tasks.$inferSelect)["triageResult"];
    lane: string | null;
    laneBilling: "subscription" | "metered" | null;
    tier: string | null;
  }>
): void {
  // The one funnel every task-cost write goes through, which is why the
  // real-money ledger (issue #174) is booked here rather than at the two call
  // sites: a later third caller cannot forget it. Only the *increment* is
  // booked, and only when the pass in hand ran on a lane that bills per token
  // — so a session whose lane was switched mid-flight has each turn's dollars
  // attributed to the lane that actually spent them, which no single column on
  // the row could say.
  if (fields.totalCostUsd !== undefined) {
    bookTaskCost(taskId, fields.totalCostUsd);
  }

  db.update(tasks)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(tasks.id, taskId))
    .run();
}

/**
 * Terminalize a run: failed consumes an attempt, cancelled does not. Any pass
 * the run still owns is cancelled alongside it, so no task outlives its run
 * (issue #124) — the same invariant the sweep's finalization points enforce,
 * centralized here for the turn-manager terminal transitions (a container
 * error, or a user cancelling a task whose run had a review already queued).
 * DB-only and idempotent: the caller has already terminalized the task in hand,
 * so this reaches only *other* non-terminal siblings; a queued orphan holds no
 * container, and the rare parked/running one becomes reaper-eligible the moment
 * its run turns terminal here.
 */
function finishRun(runId: string, status: "failed" | "cancelled", reason?: string): void {
  db.update(runs)
    .set({ status, finishedAt: new Date(), ...(reason ? { failureReason: reason } : {}) })
    .where(eq(runs.id, runId))
    .run();
  cancelOrphanedRunTasks(db, runId);
}

/**
 * Terminalize a run as `interrupted` (issue #97): an in-flight pass whose
 * container died without delivering a terminal agent result — OOM (exit 137),
 * a docker error, a stream lost to host pressure — is the platform's fault,
 * not the work's. Exactly like a restart-recovery interruption (issue #24) it
 * counts against the interruption bound, never the attempt budget, so the
 * sweep re-claims the ticket without consuming an attempt. The re-claim is
 * still bounded (MAX_INTERRUPTIONS_PER_TICKET) so a ticket that reliably
 * crashes its container eventually routes to a human instead of looping.
 */
function interruptRun(runId: string, reason: string): void {
  const run = db
    .select({ interruptionCount: runs.interruptionCount })
    .from(runs)
    .where(eq(runs.id, runId))
    .get();
  db.update(runs)
    .set({
      status: "interrupted",
      failureReason: reason,
      interruptionCount: (run?.interruptionCount ?? 0) + 1,
      finishedAt: new Date(),
    })
    .where(eq(runs.id, runId))
    .run();
}

function insertSystemMessage(taskId: string, text: string): void {
  db.insert(messages)
    .values({
      id: newId(),
      taskId,
      role: "system",
      type: "system",
      content: JSON.stringify({ text }),
      createdAt: new Date(),
    })
    .run();
}
