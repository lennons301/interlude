import { PassThrough } from "stream";
import { db } from "@/db";
import { tasks, messages, projects } from "@/db/schema";
import { eq } from "drizzle-orm";
import { newId } from "../ulid";
import {
  createAgentContainer,
  startAndAttach,
  waitForExit,
  pushBranch,
  stopContainer,
  removeContainer,
  type RunningContainer,
} from "../docker/container-manager";
import { createOutputHandler } from "./output-parser";
import { getConfig } from "../config";
import { getDocker } from "../docker/client";

// Track currently running container so we can cancel it
let activeContainer: RunningContainer | null = null;

export function getActiveContainer(): RunningContainer | null {
  return activeContainer;
}

export async function runTask(taskId: string): Promise<void> {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) throw new Error(`Task ${taskId} not found`);

  // Get project info for git URL
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, task.projectId))
    .get();
  if (!project) throw new Error(`Project ${task.projectId} not found`);
  if (!project.gitUrl) throw new Error(`Project ${project.name} has no git URL`);

  const branch = `agent/${taskId}`;
  const prompt = task.description
    ? `${task.title}\n\n${task.description}`
    : task.title;

  // Update task status
  db.update(tasks)
    .set({
      status: "running",
      branch,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId))
    .run();

  insertSystemMessage(taskId, "Provisioning agent container...");

  let running: RunningContainer | null = null;

  try {
    // Create and start container
    running = await createAgentContainer({
      taskId,
      gitUrl: project.gitUrl,
      branch,
      prompt,
    });

    activeContainer = running;

    // Store container ID
    db.update(tasks)
      .set({ containerId: running.id, updatedAt: new Date() })
      .where(eq(tasks.id, taskId))
      .run();

    insertSystemMessage(taskId, "Agent started.");

    // Attach to output stream
    const stream = await startAndAttach(running);
    const handler = createOutputHandler(taskId);

    // Demux Docker stream (Docker multiplexes stdout/stderr with headers)
    const docker = getDocker();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    docker.modem.demuxStream(stream, stdout, stderr);

    stdout.on("data", (chunk: Buffer) => handler.write(chunk));
    stderr.on("data", (chunk: Buffer) => handler.write(chunk));

    // Wait for container to exit
    const result = await waitForExit(running);
    handler.flush();

    if (result.StatusCode === 0) {
      // Success — push branch
      insertSystemMessage(taskId, "Pushing branch...");
      try {
        await pushBranch(running);
        insertSystemMessage(taskId, `✓ Branch '${branch}' pushed.`);
      } catch (err) {
        insertSystemMessage(
          taskId,
          `⚠ Branch push failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      db.update(tasks)
        .set({ status: "completed", updatedAt: new Date() })
        .where(eq(tasks.id, taskId))
        .run();
    } else {
      db.update(tasks)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(tasks.id, taskId))
        .run();
      insertSystemMessage(
        taskId,
        `✗ Agent exited with code ${result.StatusCode}`
      );
    }
  } catch (err) {
    db.update(tasks)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(tasks.id, taskId))
      .run();
    insertSystemMessage(
      taskId,
      `✗ Error: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    activeContainer = null;

    // Cleanup container
    if (running && !getConfig().keepContainers) {
      await removeContainer(running);
      db.update(tasks)
        .set({ containerId: null, updatedAt: new Date() })
        .where(eq(tasks.id, taskId))
        .run();
    }
  }
}

export async function cancelTask(taskId: string): Promise<void> {
  if (activeContainer) {
    await stopContainer(activeContainer);
    await removeContainer(activeContainer);
    activeContainer = null;
  }

  db.update(tasks)
    .set({
      status: "cancelled",
      containerId: null,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId))
    .run();

  insertSystemMessage(taskId, "Task cancelled by user.");
}

function insertSystemMessage(taskId: string, content: string): void {
  db.insert(messages)
    .values({
      id: newId(),
      taskId,
      role: "system",
      content,
      createdAt: new Date(),
    })
    .run();
}
