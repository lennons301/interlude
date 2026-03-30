import { db } from "@/db";
import { tasks, messages, projects } from "@/db/schema";
import { eq, and, isNull, asc } from "drizzle-orm";
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

  const branch = `agent/${taskId}`;
  const userPrompt = task.description
    ? `${task.title}\n\n${task.description}`
    : task.title;
  const prompt = `${userPrompt}\n\nWhen you are done with each request, commit all your changes with a descriptive commit message. Stay ready for follow-up instructions.`;

  // Update task status
  updateTask(taskId, { status: "running", branch, containerStatus: "setup" });
  insertSystemMessage(taskId, `Provisioning agent container...${proj.dopplerToken ? " (Doppler configured)" : ""}`);

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

    // Run initial turn
    const turnResult = await runTurn(taskId, running, prompt);

    // Store session ID and cost
    updateTask(taskId, {
      sessionId: turnResult.sessionId,
      containerStatus: "idle",
      totalCostUsd: turnResult.costUsd,
    });
    activeTasks.get(taskId)!.state = "idle";

    // Commit and push after turn completes
    await runPostTurnCommitAndPush(taskId, running);
    await scanForDevServer(taskId, running);
  } catch (err) {
    updateTask(taskId, { status: "failed", containerStatus: null });
    insertSystemMessage(
      taskId,
      `Error: ${err instanceof Error ? err.message : String(err)}`
    );

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
  sessionId?: string
): Promise<TurnResult> {
  const handler = createOutputHandler(taskId);

  const { stream, exec } = await execClaudeTurn({
    container: running.container,
    prompt,
    sessionId,
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
    // Get current task state
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!task || task.status !== "running") break;

    // Check budget
    if (task.totalCostUsd && task.totalCostUsd >= config.maxBudgetUsd) {
      insertSystemMessage(
        taskId,
        `Budget limit reached ($${task.totalCostUsd.toFixed(2)} / $${config.maxBudgetUsd.toFixed(2)})`
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

    if (!queued) break; // No queued messages — stay idle

    // Mark as delivered
    db.update(messages)
      .set({ deliveredAt: new Date() })
      .where(eq(messages.id, queued.id))
      .run();

    // Run next turn with the user message
    updateTask(taskId, { containerStatus: "running" });
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
      task.sessionId ?? undefined
    );

    // Update cumulative cost and session
    const currentCost = task.totalCostUsd ?? 0;
    updateTask(taskId, {
      sessionId: turnResult.sessionId ?? task.sessionId,
      containerStatus: "idle",
      totalCostUsd: currentCost + turnResult.costUsd,
    });
    activeTasks.get(taskId)!.state = "idle";

    // Commit and push after each turn
    await runPostTurnCommitAndPush(taskId, running);
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
  let entry = activeTasks.get(taskId);
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
    updateTask(taskId, { status: "completed", containerStatus: null });
  } catch (err) {
    insertSystemMessage(
      taskId,
      `Push failed: ${err instanceof Error ? err.message : String(err)}`
    );
    updateTask(taskId, { status: "failed", containerStatus: null });
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
 * After each turn, commit any uncommitted changes and push the branch.
 * This ensures work is always available on GitHub for PRs.
 */
async function runPostTurnCommitAndPush(taskId: string, running: RunningContainer): Promise<void> {
  try {
    await execFallbackCommitAndPush(running);
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    insertSystemMessage(taskId, `Branch '${task?.branch}' pushed.`);
  } catch (err) {
    insertSystemMessage(
      taskId,
      `Push warning: ${err instanceof Error ? err.message : String(err)}`
    );
    // Non-fatal — don't fail the task for a push issue
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
  }>
): void {
  db.update(tasks)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(tasks.id, taskId))
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
