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
import { getConfig } from "../config";

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
  insertSystemMessage(taskId, "Provisioning agent container...");

  let running: RunningContainer | null = null;

  try {
    // Create container
    running = await createWorkspaceContainer({ taskId, gitUrl: proj.gitUrl, branch });
    activeTasks.set(taskId, { container: running, state: "setup" });

    updateTask(taskId, { containerId: running.id });

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

    // Run fallback commit after turn completes
    await runFallbackCommit(running);
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

  // Stream output to handler. Also poll exec status as fallback —
  // Docker exec streams sometimes don't close after the process exits.
  await new Promise<void>((resolve, reject) => {
    let resolved = false;
    let poll: ReturnType<typeof setInterval> | null = null;

    const done = () => {
      if (resolved) return;
      resolved = true;
      if (poll) clearInterval(poll);
      resolve();
    };

    stream.on("data", (chunk: Buffer) => handler.write(chunk));
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
          // Process exited — give stream 500ms to flush, then resolve
          setTimeout(done, 500);
        }
      } catch {
        done();
      }
    }, 2000);
  });

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

    // Fallback commit after each turn
    await runFallbackCommit(running);
  }
}

/**
 * Complete a task: fallback commit, push, cleanup.
 */
export async function completeTask(taskId: string): Promise<void> {
  const entry = activeTasks.get(taskId);
  console.log(`[orchestrator] completeTask ${taskId}: entry=${entry ? entry.state : "NOT_FOUND"}, activeTasks.size=${activeTasks.size}`);
  if (!entry) return;

  updateTask(taskId, { containerStatus: "completing" });
  entry.state = "completing";

  try {
    await execFallbackCommitAndPush(entry.container);
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    insertSystemMessage(taskId, `Branch '${task?.branch}' pushed.`);
    updateTask(taskId, { status: "completed", containerStatus: null });
  } catch (err) {
    insertSystemMessage(
      taskId,
      `Push failed: ${err instanceof Error ? err.message : String(err)}`
    );
    updateTask(taskId, { status: "failed", containerStatus: null });
  } finally {
    activeTasks.delete(taskId);
    if (!getConfig().keepContainers) {
      await removeContainer(entry.container);
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

async function runFallbackCommit(running: RunningContainer): Promise<void> {
  try {
    const exec = await running.container.exec({
      Cmd: [
        "bash",
        "-c",
        'cd /workspace/repo && git add -A && git diff --cached --quiet || git commit -m "agent: uncommitted changes"',
      ],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({});
    await new Promise<void>((resolve) => {
      stream.on("end", resolve);
      stream.resume();
    });
  } catch {
    // Non-fatal — commit may fail if nothing to commit
  }
}

function updateTask(
  taskId: string,
  fields: Partial<{
    status: "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled";
    branch: string;
    containerId: string | null;
    containerStatus: "setup" | "running" | "idle" | "completing" | null;
    sessionId: string | null;
    totalCostUsd: number;
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
