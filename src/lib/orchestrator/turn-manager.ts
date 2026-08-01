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
import { scanPorts } from "./port-scanner";
import { getConfig } from "../config";
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
  }
>();

export function getActiveTasks() {
  return activeTasks;
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

  // Autonomous implement passes run on the ticket-loop contract branch and
  // their description is the fully framed pass prompt, baked at claim time.
  const isImplementPass = task.kind === "implement";
  const issueNumber = task.githubIssue ? parseIssueRef(task.githubIssue)?.number : undefined;
  if (isImplementPass && !issueNumber) {
    throw new Error(`Implement task ${taskId} has no parsable GitHub issue ref`);
  }
  const branch = isImplementPass ? `agent/issue-${issueNumber}` : `agent/${taskId}`;

  const userPrompt = task.description
    ? `${task.title}\n\n${task.description}`
    : task.title;
  const prompt = isImplementPass
    ? task.description
    : `${userPrompt}\n\nWhen you are done with each request, commit all your changes with a descriptive commit message. Stay ready for follow-up instructions.`;

  const run = task.runId
    ? db.select().from(runs).where(eq(runs.id, task.runId)).get()
    : undefined;

  // Update task status
  updateTask(taskId, { status: "running", branch, containerStatus: "setup" });
  insertSystemMessage(taskId, `Provisioning agent container...${proj.dopplerToken ? " (Doppler configured)" : ""}`);

  if (run) {
    db.update(runs)
      .set({ status: "implementing", startedAt: new Date() })
      .where(eq(runs.id, run.id))
      .run();
  }

  // Notify Discord channel that task is queued — but not for tasks created
  // from Discord, which already got their queued embed posted in client.ts,
  // and not for autonomous passes: their lifecycle lives on the issue thread
  // and Discord stays push-only for exceptional events.
  if (proj.discordChannelId && !task.discordMessageId && !isImplementPass) {
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
    // Create container
    running = await createWorkspaceContainer({
      taskId,
      gitUrl: proj.gitUrl,
      branch,
      dopplerToken: proj.dopplerToken ?? undefined,
    });
    activeTasks.set(taskId, { container: running, state: "setup" });

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

    // Notify GitHub issue that agent has started. Implement passes skip this:
    // the claim comment already announced the run with the task link.
    if (task.githubIssue && !isImplementPass) {
      const domain = process.env.DOMAIN ?? "interludes.co.uk";
      commentOnIssue(
        task.githubIssue,
        `Agent working\n\n[View in Interlude](https://${domain}/tasks/${taskId})`
      ).catch(console.error);
    }

    // Run initial turn. An implement pass is one whole turn — its budget is
    // the run's per-attempt budget, not the interactive per-task default.
    const turnResult = await runTurn(taskId, running, prompt, undefined, {
      maxBudgetUsd: run?.budgetUsd,
    });

    // Store session ID and cost
    updateTask(taskId, {
      sessionId: turnResult.sessionId,
      containerStatus: "idle",
      totalCostUsd: turnResult.costUsd,
    });
    if (run) {
      db.update(runs)
        .set({ totalCostUsd: turnResult.costUsd })
        .where(eq(runs.id, run.id))
        .run();
    }
    activeTasks.get(taskId)!.state = "idle";

    // Commit and push after turn completes
    await runPostTurnCommitAndPush(taskId, running);

    if (isImplementPass) {
      // The pass's turn is over: park it if its final message leads with the
      // BLOCKED marker (container kept alive, question escalated), otherwise
      // complete now — final push, PR marked ready, container removed. The
      // run stays `implementing` until #17's review machinery takes over.
      const parked = await evaluatePassOutcome(taskId);
      if (!parked) await completeTask(taskId);
      return;
    }

    await scanForDevServer(taskId, running);
    await postIdleNotification(taskId);
  } catch (err) {
    updateTask(taskId, { status: "failed", containerStatus: null });
    if (task.runId) finishRun(task.runId, "failed");
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
 * Run a single Claude turn and stream output to DB.
 */
async function runTurn(
  taskId: string,
  running: RunningContainer,
  prompt: string,
  sessionId?: string,
  opts?: { maxBudgetUsd?: number }
): Promise<TurnResult> {
  const handler = createOutputHandler(taskId);

  const { stream, exec } = await execClaudeTurn({
    container: running.container,
    prompt,
    sessionId,
    maxBudgetUsd: opts?.maxBudgetUsd,
  });

  // Race: wait for the exec stream to close OR the "result" event from Claude.
  // Background processes (e.g. dev servers) can keep the exec stream open
  // long after Claude exits, so the result event is the reliable signal.
  const resultReceived = new Promise<void>((resolve) => handler.onDone(resolve));

  await Promise.race([
    waitForExecStream(stream, exec, (chunk) => handler.write(chunk)),
    resultReceived,
  ]);

  return handler.flush();
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

    // Check budget — a run-owned task is bounded by its run's attempt budget,
    // an interactive task by the global per-task default
    const run = task.runId
      ? db.select().from(runs).where(eq(runs.id, task.runId)).get()
      : undefined;
    const budgetCapUsd = run?.budgetUsd ?? config.maxBudgetUsd;
    if (task.totalCostUsd && task.totalCostUsd >= budgetCapUsd) {
      insertSystemMessage(
        taskId,
        `Budget limit reached ($${task.totalCostUsd.toFixed(2)} / $${budgetCapUsd.toFixed(2)})`
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
      // No more queued messages. An interactive agent is idle — notify
      // Discord ("your move"). A parked implement pass just stays parked:
      // its blocked embed is already the outstanding ask.
      if (task.kind !== "implement") await postIdleNotification(taskId);
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

    const turnResult = await runTurn(
      taskId,
      running,
      promptText,
      task.sessionId ?? undefined,
      { maxBudgetUsd: run?.budgetUsd }
    );

    // Update cumulative cost and session
    const currentCost = task.totalCostUsd ?? 0;
    updateTask(taskId, {
      sessionId: turnResult.sessionId ?? task.sessionId,
      containerStatus: "idle",
      totalCostUsd: currentCost + turnResult.costUsd,
    });
    if (run) {
      db.update(runs)
        .set({ totalCostUsd: currentCost + turnResult.costUsd })
        .where(eq(runs.id, run.id))
        .run();
    }
    activeTasks.get(taskId)!.state = "idle";

    // Commit and push after each turn
    await runPostTurnCommitAndPush(taskId, running);

    if (task.kind === "implement") {
      // Park-or-proceed again: the resumed pass may hit another unresolved
      // decision, or run to a healthy finish — which completes it.
      const parked = await evaluatePassOutcome(taskId);
      if (!parked) {
        await completeTask(taskId);
        break;
      }
      continue;
    }

    await scanForDevServer(taskId, running);
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
      db.update(runs)
        .set({
          totalCostUsd: task.totalCostUsd ?? 0,
          pullRequestNumber: task.pullRequestNumber,
          pullRequestUrl: task.pullRequestUrl,
        })
        .where(eq(runs.id, task.runId))
        .run();
    }

    // Notify Discord — but not for autonomous passes: routine success is
    // deliberately silent, it belongs on the issue thread and the dashboard.
    const proj = db.select().from(projects).where(eq(projects.id, task.projectId)).get();
    if (proj?.discordChannelId && task.kind !== "implement") {
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
    if (task.runId) finishRun(task.runId, "failed");
  } finally {
    activeTasks.delete(taskId);
    if (running && !getConfig().keepContainers) {
      await removeContainer(running);
      updateTask(taskId, { containerId: null });
    }
  }
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
 * ask the reducer about the turn's final message. Blocked — park the run
 * with its container alive and post the question; returns true. Healthy —
 * returns false and the caller proceeds to completion.
 */
async function evaluatePassOutcome(taskId: string): Promise<boolean> {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task?.runId) return false;

  const actions = decideNext(
    passOutcomeSnapshot(new Date(), {
      runId: task.runId,
      taskId,
      issueRef: task.githubIssue ?? "",
      finalMessage: lastAgentTextMessage(taskId),
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
          if (task.githubIssue) {
            await commentOnIssue(task.githubIssue, `Draft PR opened: #${pr.number}`);
          }
          console.log(`[github] Draft PR #${pr.number} created for task ${taskId}`);
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
  }>
): void {
  db.update(tasks)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(tasks.id, taskId))
    .run();
}

/** Terminalize a run: failed consumes an attempt, cancelled does not. */
function finishRun(runId: string, status: "failed" | "cancelled"): void {
  db.update(runs)
    .set({ status, finishedAt: new Date() })
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
