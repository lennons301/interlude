import { db } from "@/db";
import { tasks, messages, projects, runs } from "@/db/schema";
import { eq, and, isNull, asc, desc } from "drizzle-orm";
import { newId } from "../ulid";
import {
  createWorkspaceContainer,
  execSetup,
  execClaudeTurn,
  execFallbackCommitAndPush,
  removeContainer,
  stopContainer,
  type RunningContainer,
} from "../docker/container-manager";
import { createOutputHandler, type TurnResult } from "./output-parser";
import { parseReviewVerdict } from "./autonomy/verdict";
import { parseTriageExit } from "./autonomy/triage";
import {
  DEFAULT_REPAIR_BUDGET_USD,
  DEFAULT_REVIEW_BUDGET_USD,
  DEFAULT_TRIAGE_BUDGET_USD,
  MAX_ATTEMPTS,
  TRIAGE_MAX_TURNS,
} from "./autonomy/budgets";
import { scanPorts } from "./port-scanner";
import { getConfig, resolveAgentModel, type AgentPassKind } from "../config";
import { getDocker } from "../docker/client";
import { commentOnIssue, parseIssueRef } from "../github/issues";
import { parseRepoFromGitUrl } from "../github/repo";
import { createDraftPr, markPrReady } from "../github/pull-requests";
import { notifyTaskQueued, notifyTaskCompleted, notifyTaskFailed, notifyTaskIdle, notifyRunBlocked } from "../discord/notifications";
import { decideNext, passOutcomeSnapshot } from "./autonomy/decide";

/** Track all active task containers for cancellation and idle polling */
const activeTasks = new Map<
  string,
  {
    container: RunningContainer;
    state: "setup" | "running" | "idle" | "completing";
    kind: AgentPassKind;
  }
>();

export function getActiveTasks() {
  return activeTasks;
}

/**
 * An idle autonomous container is *parked*: an implement pass waiting on its
 * review verdict, or blocked on a question to the owner (issue #19), keeps
 * its container (so the verdict's fix-up or the owner's answer can be a
 * follow-up turn in the same attempt) but runs no agent process, so it does
 * not hold a slot. An idle interactive session does hold its slot — its dev
 * server and the owner's next message are live concerns. Without this
 * distinction, two parked implements plus their two queued reviews would
 * deadlock a two-slot box.
 */
export function isParked(entry: { state: string; kind: string }): boolean {
  return entry.state === "idle" && entry.kind !== "interactive";
}

export function getTaskState(taskId: string) {
  return activeTasks.get(taskId)?.state ?? null;
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
  const prompt = isAutonomousPass
    ? task.description
    : `${userPrompt}\n\nWhen you are done with each request, commit all your changes with a descriptive commit message. Stay ready for follow-up instructions.`;

  const run = task.runId
    ? db.select().from(runs).where(eq(runs.id, task.runId)).get()
    : undefined;

  // The model this pass runs on, pinned by kind (issue #74). Passed to every
  // turn as `--model` and recorded on the run row below so spend is
  // interpretable against the tier it was earned on.
  const passModel = resolveAgentModel(task.kind);

  // Update task status
  updateTask(taskId, { status: "running", branch, containerStatus: "setup" });
  insertSystemMessage(taskId, `Provisioning agent container...${proj.dopplerToken ? " (Doppler configured)" : ""}`);

  // Only an implement-shaped pass moves the run to `implementing` — a review
  // pass starting must not drag a `reviewing`/`gated` run backwards. A repair
  // pass keeps the run's original startedAt so the dashboard's elapsed time
  // does not jump when a conflict is repaired mid-life.
  if (run && isImplementShaped) {
    // Record the implement-pass model on the run — it drives the bulk of a
    // run's spend, so it is the tier the run's cost should be read against. A
    // review pass writes its own (cheaper) model nowhere on the run, leaving
    // this value stable. Repair keeps the original implement model (same tier).
    db.update(runs)
      .set({
        status: "implementing",
        startedAt: run.startedAt ?? new Date(),
        model: passModel,
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

  let running: RunningContainer | null = null;

  try {
    // Create container. Review and triage passes receive no credential beyond
    // the App token their setup uses for cloning — not even the project's
    // Doppler secrets: they read code, they don't run the app. A repair pass
    // is implement-shaped — it merges, pushes, and runs the repo's tests and
    // lint — so it gets the same Doppler secrets an implement pass does, or a
    // test that needs them would behave differently than under implement.
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
    await execSetup(running);

    insertSystemMessage(taskId, "Agent started.");
    updateTask(taskId, { containerStatus: "running" });
    activeTasks.get(taskId)!.state = "running";

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

    // Run initial turn. An autonomous pass is one whole turn — an implement
    // pass carries the run's per-attempt budget, a review pass its own
    // smaller allowance, a triage pass the smallest of all plus a hard turn
    // cap, never the interactive per-task default. Review and triage keep
    // their raw stream: the structured exit is parsed from it.
    const turnResult = await runTurn(taskId, running, prompt, undefined, {
      maxBudgetUsd: isReviewPass
        ? DEFAULT_REVIEW_BUDGET_USD
        : isTriagePass
          ? DEFAULT_TRIAGE_BUDGET_USD
          : isRepairPass
            ? DEFAULT_REPAIR_BUDGET_USD
            : run?.budgetUsd,
      maxTurns: isTriagePass
        ? TRIAGE_MAX_TURNS
        : isReviewPass || isRepairPass
          ? undefined
          : (run?.maxTurns ?? undefined),
      captureRaw: isReviewPass || isTriagePass,
      model: passModel,
    });

    // Store session ID and cost
    updateTask(taskId, {
      sessionId: turnResult.sessionId,
      containerStatus: "idle",
      totalCostUsd: turnResult.costUsd,
    });
    if (run) syncRunCost(run.id);
    activeTasks.get(taskId)!.state = "idle";

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
      // Exhaustion first (issue #18) — but only for a real implement attempt.
      // A repair pass (issue #54) is never an attempt, so a repair that spent
      // its budget without clearing the conflict still parks: the sweep's
      // conflict check then escalates the still-CONFLICTING PR to a human,
      // rather than the repair burning a strike.
      if (isImplementPass) {
        const exhaustion = run ? attemptExhaustion(run, turnResult.costUsd, turnResult.subtype) : null;
        if (exhaustion) {
          await failImplementAttempt(taskId, run!.id, exhaustion);
          return;
        }
      }
      // The pass's turn is over: park it blocked if its final message leads
      // with the BLOCKED marker — container kept alive, question escalated
      // to the owner (issue #19). Otherwise the initial turn is the whole
      // pass: mark the PR ready and park the container awaiting review — it
      // stays alive (holding no slot) so a request-changes verdict can
      // deliver a fix-up turn into the same attempt. The run stays
      // `implementing`; the sweep's gate evaluation takes over from here.
      const parkedBlocked = await evaluatePassOutcome(taskId, turnResult.finalMessage);
      if (!parkedBlocked) await finishImplementPass(taskId);
      return;
    }

    await scanForDevServer(taskId, running);
    await postIdleNotification(taskId);
  } catch (err) {
    // A triage pass that died delivered no exit. Store the failure as an
    // unparseable result so the fail-closed path (nothing applied, the
    // owner told once, needs-triage kept) runs instead of a silent retry.
    // But never clobber an exit finishTriagePass already stored — a teardown
    // failure after the store must not turn a good exit into an unparseable
    // one (the sweep applies stored exits regardless of task status).
    const storedExit = isTriagePass
      ? db.select().from(tasks).where(eq(tasks.id, taskId)).get()?.triageResult
      : null;
    updateTask(taskId, {
      status: "failed",
      containerStatus: null,
      ...(isTriagePass && storedExit == null
        ? {
            triageResult: {
              kind: "unparseable" as const,
              reason: `triage pass failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          }
        : {}),
    });
    if (task.runId) {
      if (isReviewPass) {
        // A review pass that died is not a failed attempt — the implement
        // work is intact. Store the failure as an unparseable verdict so
        // the fail-closed path (no merge, human-signoff, owner told) runs.
        db.update(runs)
          .set({
            reviewResult: {
              kind: "unparseable",
              reason: `review pass failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          })
          .where(eq(runs.id, task.runId))
          .run();
      } else {
        finishRun(
          task.runId,
          "failed",
          `container error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    insertSystemMessage(
      taskId,
      `Error: ${err instanceof Error ? err.message : String(err)}`
    );

    if (task.githubIssue) {
      const domain = process.env.DOMAIN ?? "interludes.co.uk";
      commentOnIssue(
        task.githubIssue,
        `Task failed -- check [Interlude](https://${domain}/tasks/${taskId}) for details`
      ).catch(console.error);
    }

    if (proj.discordChannelId) {
      notifyTaskFailed(proj.discordChannelId, {
        id: taskId,
        title: task.title,
        error: err instanceof Error ? err.message : String(err),
      }).catch(console.error);
    }

    if (running) {
      activeTasks.delete(taskId);
      if (!getConfig().keepContainers) {
        await removeContainer(running);
        updateTask(taskId, { containerId: null });
      }
    }
  }
}

/**
 * Run a single Claude turn and stream output to DB. With `captureRaw` the
 * raw stream-json is also returned — a review pass's verdict is parsed from
 * it after the turn ends.
 */
async function runTurn(
  taskId: string,
  running: RunningContainer,
  prompt: string,
  sessionId?: string,
  opts?: {
    maxBudgetUsd?: number;
    maxTurns?: number;
    captureRaw?: boolean;
    model?: string | null;
  }
): Promise<TurnResult & { raw?: string }> {
  const handler = createOutputHandler(taskId);
  const rawChunks: Buffer[] = [];

  const { stream, exec } = await execClaudeTurn({
    container: running.container,
    prompt,
    sessionId,
    maxBudgetUsd: opts?.maxBudgetUsd,
    maxTurns: opts?.maxTurns,
    model: opts?.model,
  });

  // Race: wait for the exec stream to close OR the "result" event from Claude.
  // Background processes (e.g. dev servers) can keep the exec stream open
  // long after Claude exits, so the result event is the reliable signal.
  const resultReceived = new Promise<void>((resolve) => handler.onDone(resolve));

  await Promise.race([
    waitForExecStream(stream, exec, (chunk) => {
      handler.write(chunk);
      if (opts?.captureRaw) rawChunks.push(chunk);
    }),
    resultReceived,
  ]);

  const result = handler.flush();
  if (!opts?.captureRaw) return result;
  return { ...result, raw: Buffer.concat(rawChunks).toString() };
}

/**
 * Check for queued user messages and run follow-up turns.
 */
export async function processQueuedMessages(
  taskId: string,
  running: RunningContainer
): Promise<void> {
  const config = getConfig();

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
    if (task.totalCostUsd && task.totalCostUsd >= budgetUsd) {
      if (run) {
        await failImplementAttempt(
          taskId,
          run.id,
          `budget exhausted ($${task.totalCostUsd.toFixed(2)} of $${budgetUsd.toFixed(2)})`
        );
        break;
      }
      insertSystemMessage(
        taskId,
        `Budget limit reached ($${task.totalCostUsd.toFixed(2)} / $${budgetUsd.toFixed(2)})`
      );
      await completeTask(taskId);
      break;
    }

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

    // Mark as delivered
    db.update(messages)
      .set({ deliveredAt: new Date() })
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
    activeTasks.get(taskId)!.state = "running";

    // Extract raw text from JSON content for the CLI prompt
    let promptText = queued.content;
    try {
      const parsed = JSON.parse(queued.content);
      if (parsed.text) promptText = parsed.text;
    } catch {
      // Plain text content — use as-is
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
        maxBudgetUsd: run ? run.budgetUsd - (task.totalCostUsd ?? 0) : undefined,
        maxTurns: run?.maxTurns ?? undefined,
        model: resolveAgentModel(task.kind),
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
    activeTasks.get(taskId)!.state = "idle";

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
        ? attemptExhaustion(run, currentCost + turnResult.costUsd, turnResult.subtype)
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
      const parkedBlocked = await evaluatePassOutcome(taskId, turnResult.finalMessage);
      if (!parkedBlocked && !run?.pullRequestNumber) {
        await finishImplementPass(taskId);
      }
      continue;
    }

    if (task.kind === "interactive") await scanForDevServer(taskId, running);
  }
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
  }

  updateTask(taskId, { containerStatus: "completing" });
  if (entry) entry.state = "completing";

  try {
    if (running) {
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

  const entry = activeTasks.get(taskId);
  activeTasks.delete(taskId);
  if (entry && !getConfig().keepContainers) {
    await removeContainer(entry.container);
    updateTask(taskId, { containerId: null });
  }
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

  if (runId) {
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

/** Record completion and remove the container (unless kept for debugging). */
async function teardownTaskContainer(
  taskId: string,
  running: RunningContainer | null
): Promise<void> {
  updateTask(taskId, { status: "completed", containerStatus: null });
  activeTasks.delete(taskId);
  if (running && !getConfig().keepContainers) {
    await removeContainer(running);
    updateTask(taskId, { containerId: null });
  }
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
 * Park-or-proceed for an implement pass whose turn just ended (issue #19):
 * ask the reducer about the turn's final message — this turn's, from its
 * TurnResult, never an earlier turn's re-read. Blocked — park the run with
 * its container alive and post the question; returns true. Healthy —
 * returns false and the caller proceeds (park awaiting review, or complete).
 */
async function evaluatePassOutcome(
  taskId: string,
  finalMessage: string | null
): Promise<boolean> {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task?.runId || !task.githubIssue) return false;

  const actions = decideNext(
    passOutcomeSnapshot(new Date(), {
      runId: task.runId,
      taskId,
      issueRef: task.githubIssue,
      finalMessage,
    })
  );

  for (const action of actions) {
    if (action.type === "escalate" && action.reason === "blocked") {
      await parkBlockedRun(taskId, action.runId, action.question);
      return true;
    }
  }
  return false;
}

/**
 * Park a blocked run: the run and task go `blocked`, the container stays
 * alive holding its context, and the question is posted to the project's
 * linked Discord channel — or the fleet channel when the project has none,
 * so no question is silently lost. The posted message becomes the task's
 * interactive message: a reply to it queues the answer as the next turn.
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
 */
export async function cancelTask(taskId: string): Promise<void> {
  const entry = activeTasks.get(taskId);
  if (entry) {
    await stopContainer(entry.container);
    await removeContainer(entry.container);
    activeTasks.delete(taskId);
  }

  updateTask(taskId, {
    status: "cancelled",
    containerId: null,
    containerStatus: null,
  });
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  // Owner-cancelled runs don't consume an attempt: cancelled is not failed
  if (task?.runId) finishRun(task.runId, "cancelled");
  insertSystemMessage(taskId, "Task cancelled by user.");
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
    await execFallbackCommitAndPush(running);
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    insertSystemMessage(taskId, `Branch '${task?.branch}' pushed.`);

    // Create draft PR on first push if none exists yet (any task origin)
    if (task && !task.pullRequestNumber && task.branch) {
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
  }>
): void {
  db.update(tasks)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(tasks.id, taskId))
    .run();
}

/** Terminalize a run: failed consumes an attempt, cancelled does not. */
function finishRun(runId: string, status: "failed" | "cancelled", reason?: string): void {
  db.update(runs)
    .set({ status, finishedAt: new Date(), ...(reason ? { failureReason: reason } : {}) })
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
