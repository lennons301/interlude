# Phase 2a: Agent Orchestrator + Local Docker — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mock agent with real Claude Code CLI execution inside Docker containers, with output streaming back to the UI in real-time.

**Architecture:** A task runner polls the DB for queued tasks, provisions Docker containers via `dockerode`, runs Claude Code CLI in print mode (`-p`) with `--output-format stream-json`, parses the streaming output into messages, and pushes a git branch on completion. One task runs at a time (sequential queue).

**Tech Stack:** dockerode, @types/dockerode, Docker, Claude Code CLI (`@anthropic-ai/claude-code`), Node.js streams.

**Spec:** `docs/specs/2026-03-11-phase2a-agent-orchestrator-design.md`

---

## File Structure

```
Dockerfile.agent                — Docker image for agent containers
src/
  lib/
    docker/
      client.ts                 — Shared dockerode client instance
      image-builder.ts          — Build/cache the agent Docker image
      container-manager.ts      — Create, start, stop, remove containers
    orchestrator/
      task-runner.ts            — Run a single task end-to-end
      output-parser.ts          — Parse Claude Code stream-json output into messages
      queue.ts                  — Poll DB for queued tasks, dispatch to task runner
    config.ts                   — Load and validate env vars
  db/
    schema.ts                   — (modify) Add containerId, branch to tasks; gitUrl to projects
  app/
    api/
      tasks/[id]/
        run/route.ts            — POST: trigger real agent execution
        cancel/route.ts         — POST: kill container, cancel task
      settings/
        docker/route.ts         — GET: Docker daemon + image status
drizzle/                        — (new migration generated)
.env.example                    — Document required env vars
```

---

## Chunk 1: Foundation — Docker Client, Config, Schema

### Task 1: Install dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install dockerode and types**

```bash
pnpm add dockerode
pnpm add -D @types/dockerode
```

- [ ] **Step 2: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add dockerode for Docker API access"
```

---

### Task 2: Configuration module

**Files:**
- Create: `src/lib/config.ts`
- Create: `.env.example`

- [ ] **Step 1: Create config loader**

Create `src/lib/config.ts`:

```typescript
export interface AppConfig {
  anthropicApiKey: string;
  gitToken: string;
  gitUserName: string;
  gitUserEmail: string;
  keepContainers: boolean;
}

let _config: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (_config) return _config;

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const gitToken = process.env.GIT_TOKEN;

  if (!anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is required");
  }
  if (!gitToken) {
    throw new Error("GIT_TOKEN is required");
  }

  _config = {
    anthropicApiKey,
    gitToken,
    gitUserName: process.env.GIT_USER_NAME ?? "Interlude Agent",
    gitUserEmail: process.env.GIT_USER_EMAIL ?? "agent@interlude.dev",
    keepContainers: process.env.KEEP_CONTAINERS === "true",
  };

  return _config;
}
```

- [ ] **Step 2: Create .env.example**

Create `.env.example`:

```
# Required
ANTHROPIC_API_KEY=sk-ant-...
GIT_TOKEN=ghp_...

# Optional
GIT_USER_NAME=Interlude Agent
GIT_USER_EMAIL=agent@interlude.dev
KEEP_CONTAINERS=false
```

- [ ] **Step 3: Add .env to .gitignore**

Append to `.gitignore`:
```
.env
.env.local
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/config.ts .env.example .gitignore
git commit -m "feat: add configuration module for agent env vars"
```

---

### Task 3: Schema changes

**Files:**
- Modify: `src/db/schema.ts`

- [ ] **Step 1: Add new columns**

Add to `tasks` table definition (after `githubIssue`):

```typescript
  containerId: text("container_id"),
  branch: text("branch"),
```

Add to `projects` table definition (after `githubRepo`):

```typescript
  gitUrl: text("git_url"),
```

- [ ] **Step 2: Generate migration**

```bash
npx drizzle-kit generate
```

This creates a new SQL migration file in `drizzle/`.

- [ ] **Step 3: Verify migration applies**

```bash
rm -f local.db && npx tsx -e "
import { db } from './src/db';
import { tasks, projects } from './src/db/schema';
console.log('Migration OK');
"
```

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat: add containerId, branch to tasks; gitUrl to projects"
```

---

### Task 4: Docker client

**Files:**
- Create: `src/lib/docker/client.ts`

- [ ] **Step 1: Create shared Docker client**

Create `src/lib/docker/client.ts`:

```typescript
import Docker from "dockerode";

let _docker: Docker | null = null;

export function getDocker(): Docker {
  if (!_docker) {
    _docker = new Docker({ socketPath: "/var/run/docker.sock" });
  }
  return _docker;
}

export async function isDockerAvailable(): Promise<boolean> {
  try {
    await getDocker().ping();
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/docker/client.ts
git commit -m "feat: add shared dockerode client"
```

---

## Chunk 2: Docker Image and Container Manager

### Task 5: Agent Docker image

**Files:**
- Create: `Dockerfile.agent`
- Create: `src/lib/docker/image-builder.ts`

- [ ] **Step 1: Create Dockerfile**

Create `Dockerfile.agent` at project root:

```dockerfile
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

RUN useradd -m -u 1000 agent && mkdir -p /workspace && chown agent:agent /workspace
USER agent

WORKDIR /workspace
```

- [ ] **Step 2: Create image builder**

Create `src/lib/docker/image-builder.ts`:

```typescript
import fs from "fs";
import path from "path";
import { pack } from "tar-fs";
import { getDocker } from "./client";

const IMAGE_NAME = "interlude-agent";
const IMAGE_TAG = "latest";

export function getImageName(): string {
  return `${IMAGE_NAME}:${IMAGE_TAG}`;
}

export async function imageExists(): Promise<boolean> {
  const docker = getDocker();
  try {
    await docker.getImage(getImageName()).inspect();
    return true;
  } catch {
    return false;
  }
}

export async function buildImage(
  onProgress?: (message: string) => void
): Promise<void> {
  const docker = getDocker();
  const contextPath = path.join(process.cwd(), ".");
  const dockerfilePath = "Dockerfile.agent";

  const tarStream = pack(contextPath, {
    entries: ["Dockerfile.agent"],
  });

  const stream = await docker.buildImage(tarStream, {
    t: getImageName(),
    dockerfile: dockerfilePath,
  });

  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      stream,
      (err) => (err ? reject(err) : resolve()),
      (event) => {
        if (event.stream && onProgress) {
          onProgress(event.stream.trim());
        }
      }
    );
  });
}

export async function ensureImage(
  onProgress?: (message: string) => void
): Promise<void> {
  if (await imageExists()) return;
  await buildImage(onProgress);
}
```

- [ ] **Step 3: Install tar-fs**

```bash
pnpm add tar-fs
pnpm add -D @types/tar-fs
```

- [ ] **Step 4: Verify image builds** (requires Docker daemon running)

```bash
npx tsx -e "
import { buildImage } from './src/lib/docker/image-builder';
buildImage((msg) => console.log(msg)).then(() => console.log('Image built'));
"
```

- [ ] **Step 5: Commit**

```bash
git add Dockerfile.agent src/lib/docker/image-builder.ts package.json pnpm-lock.yaml
git commit -m "feat: add agent Docker image and image builder"
```

---

### Task 6: Container manager

**Files:**
- Create: `src/lib/docker/container-manager.ts`

- [ ] **Step 1: Create container manager**

Create `src/lib/docker/container-manager.ts`:

```typescript
import Docker from "dockerode";
import { getDocker } from "./client";
import { getImageName, ensureImage } from "./image-builder";
import { getConfig } from "../config";

export interface ContainerOptions {
  taskId: string;
  gitUrl: string;
  branch: string;
  prompt: string;
}

export interface RunningContainer {
  container: Docker.Container;
  id: string;
}

export async function createAgentContainer(
  options: ContainerOptions
): Promise<RunningContainer> {
  const docker = getDocker();
  const config = getConfig();

  await ensureImage();

  const container = await docker.createContainer({
    Image: getImageName(),
    name: `interlude-task-${options.taskId}`,
    Env: [
      `ANTHROPIC_API_KEY=${config.anthropicApiKey}`,
      `GIT_TOKEN=${config.gitToken}`,
      `GIT_URL=${options.gitUrl}`,
      `GIT_BRANCH=${options.branch}`,
      `GIT_USER_NAME=${config.gitUserName}`,
      `GIT_USER_EMAIL=${config.gitUserEmail}`,
      `TASK_PROMPT=${options.prompt}`,
    ],
    Cmd: [
      "bash",
      "-c",
      [
        // Configure git
        'git config --global user.name "$GIT_USER_NAME"',
        'git config --global user.email "$GIT_USER_EMAIL"',
        // Clone repo using token
        'git clone "https://${GIT_TOKEN}@${GIT_URL#https://}" /workspace/repo',
        "cd /workspace/repo",
        // Create branch
        'git checkout -b "$GIT_BRANCH"',
        // Run Claude Code
        'claude -p "$TASK_PROMPT" --output-format stream-json',
      ].join(" && "),
    ],
    WorkingDir: "/workspace",
    HostConfig: {
      NetworkMode: "bridge",
    },
  });

  return { container, id: container.id };
}

export async function startAndAttach(
  running: RunningContainer
): Promise<NodeJS.ReadableStream> {
  const stream = await running.container.attach({
    stream: true,
    stdout: true,
    stderr: true,
  });

  await running.container.start();

  return stream;
}

export async function waitForExit(
  running: RunningContainer
): Promise<{ StatusCode: number }> {
  return running.container.wait();
}

export async function pushBranch(
  running: RunningContainer
): Promise<void> {
  const exec = await running.container.exec({
    Cmd: ["bash", "-c", "cd /workspace/repo && git push origin HEAD"],
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({});
  // Wait for push to complete
  await new Promise<void>((resolve) => {
    stream.on("end", resolve);
    stream.resume(); // drain the stream
  });
}

export async function stopContainer(
  running: RunningContainer
): Promise<void> {
  try {
    await running.container.stop({ t: 5 });
  } catch {
    // Already stopped
  }
}

export async function removeContainer(
  running: RunningContainer
): Promise<void> {
  try {
    await running.container.remove({ force: true });
  } catch {
    // Already removed
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/docker/container-manager.ts
git commit -m "feat: add container manager for agent lifecycle"
```

---

## Chunk 3: Output Parser and Task Runner

### Task 7: Output parser

**Files:**
- Create: `src/lib/orchestrator/output-parser.ts`

The Claude Code CLI with `--output-format stream-json` outputs newline-delimited JSON. Each line is a JSON object representing an event (assistant message, tool use, result, etc.). We need to parse these into user-friendly messages.

- [ ] **Step 1: Create output parser**

Create `src/lib/orchestrator/output-parser.ts`:

```typescript
import { db } from "@/db";
import { messages } from "@/db/schema";
import { newId } from "../ulid";

/**
 * Parse Claude Code stream-json output and insert messages into DB.
 *
 * stream-json format emits NDJSON lines. Key event types:
 * - assistant: text content from Claude
 * - tool_use: tool invocations (file edits, bash commands, etc.)
 * - result: final result with cost info
 * - system: system messages
 */
export function createOutputHandler(taskId: string) {
  let buffer = "";

  return {
    /**
     * Feed raw data chunks from the Docker stream.
     * Handles partial lines via buffering.
     */
    write(chunk: Buffer | string): void {
      buffer += chunk.toString();

      const lines = buffer.split("\n");
      // Keep the last incomplete line in the buffer
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.parseLine(trimmed);
      }
    },

    /**
     * Flush any remaining buffer (call when stream ends).
     */
    flush(): void {
      if (buffer.trim()) {
        this.parseLine(buffer.trim());
        buffer = "";
      }
    },

    parseLine(line: string): void {
      try {
        const event = JSON.parse(line);
        const content = extractContent(event);
        if (content) {
          db.insert(messages)
            .values({
              id: newId(),
              taskId,
              role: "agent",
              content,
              createdAt: new Date(),
            })
            .run();
        }
      } catch {
        // Not valid JSON — insert as raw output
        if (line.length > 0) {
          db.insert(messages)
            .values({
              id: newId(),
              taskId,
              role: "system",
              content: line,
              createdAt: new Date(),
            })
            .run();
        }
      }
    },
  };
}

function extractContent(event: Record<string, unknown>): string | null {
  // Handle different event types from stream-json
  const type = event.type as string | undefined;

  if (type === "assistant" || type === "text") {
    // Assistant text message
    const message = event.message as string | undefined;
    const text = event.text as string | undefined;
    return message ?? text ?? null;
  }

  if (type === "tool_use") {
    // Tool invocation — show what the agent is doing
    const name = event.name as string ?? "tool";
    const input = event.input as Record<string, unknown> | undefined;

    if (name === "bash" || name === "Bash") {
      const cmd = input?.command as string;
      return cmd ? `$ ${cmd}` : `→ Running ${name}`;
    }
    if (name === "write" || name === "Write") {
      const filePath = input?.file_path as string;
      return filePath ? `→ Writing ${filePath}` : `→ Writing file`;
    }
    if (name === "edit" || name === "Edit") {
      const filePath = input?.file_path as string;
      return filePath ? `→ Editing ${filePath}` : `→ Editing file`;
    }
    if (name === "read" || name === "Read") {
      const filePath = input?.file_path as string;
      return filePath ? `→ Reading ${filePath}` : `→ Reading file`;
    }

    return `→ Using ${name}`;
  }

  if (type === "tool_result") {
    // Tool output — skip verbose output, just note completion
    return null;
  }

  if (type === "result") {
    // Final result
    const cost = event.cost_usd as number | undefined;
    const costStr = cost !== undefined ? ` (cost: $${cost.toFixed(4)})` : "";
    return `✓ Agent finished${costStr}`;
  }

  if (type === "error") {
    const message = event.message as string ?? "Unknown error";
    return `✗ Error: ${message}`;
  }

  return null;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/orchestrator/output-parser.ts
git commit -m "feat: add output parser for Claude Code stream-json"
```

---

### Task 8: Task runner

**Files:**
- Create: `src/lib/orchestrator/task-runner.ts`

- [ ] **Step 1: Create task runner**

Create `src/lib/orchestrator/task-runner.ts`:

```typescript
import { db } from "@/db";
import { tasks, messages } from "@/db/schema";
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
  const project = db.query.projects.findFirst({
    where: (projects, { eq }) => eq(projects.id, task.projectId),
  });
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
    const stdout = new (require("stream").PassThrough)();
    const stderr = new (require("stream").PassThrough)();
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
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/orchestrator/task-runner.ts
git commit -m "feat: add task runner for end-to-end agent execution"
```

---

### Task 9: Task queue

**Files:**
- Create: `src/lib/orchestrator/queue.ts`

- [ ] **Step 1: Create queue poller**

Create `src/lib/orchestrator/queue.ts`:

```typescript
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { eq, asc } from "drizzle-orm";
import { runTask } from "./task-runner";

let running = false;
let pollInterval: ReturnType<typeof setInterval> | null = null;

export function startQueue(): void {
  if (pollInterval) return;

  console.log("[orchestrator] Queue started, polling every 2s");

  pollInterval = setInterval(async () => {
    if (running) return; // One task at a time

    const next = db
      .select()
      .from(tasks)
      .where(eq(tasks.status, "queued"))
      .orderBy(asc(tasks.createdAt))
      .get();

    if (!next) return;

    running = true;
    console.log(`[orchestrator] Picked up task: ${next.id} — ${next.title}`);

    try {
      await runTask(next.id);
    } catch (err) {
      console.error(`[orchestrator] Task ${next.id} failed:`, err);
    } finally {
      running = false;
    }
  }, 2000);
}

export function stopQueue(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

export function isQueueRunning(): boolean {
  return running;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/orchestrator/queue.ts
git commit -m "feat: add task queue with sequential processing"
```

---

## Chunk 4: API Routes and Startup

### Task 10: API routes

**Files:**
- Create: `src/app/api/tasks/[id]/run/route.ts`
- Create: `src/app/api/tasks/[id]/cancel/route.ts`
- Create: `src/app/api/settings/docker/route.ts`

- [ ] **Step 1: Create run endpoint**

Create `src/app/api/tasks/[id]/run/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { eq } from "drizzle-orm";
import { runTask } from "@/lib/orchestrator/task-runner";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!task) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (task.status !== "queued") {
    return NextResponse.json(
      { error: `Task is ${task.status}, must be queued` },
      { status: 400 }
    );
  }

  // Fire-and-forget
  runTask(id).catch(console.error);

  return NextResponse.json({ started: true });
}
```

- [ ] **Step 2: Create cancel endpoint**

Create `src/app/api/tasks/[id]/cancel/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { eq } from "drizzle-orm";
import { cancelTask } from "@/lib/orchestrator/task-runner";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!task) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (task.status !== "running") {
    return NextResponse.json(
      { error: `Task is ${task.status}, can only cancel running tasks` },
      { status: 400 }
    );
  }

  await cancelTask(id);
  return NextResponse.json({ cancelled: true });
}
```

- [ ] **Step 3: Create Docker status endpoint**

Create `src/app/api/settings/docker/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { isDockerAvailable } from "@/lib/docker/client";
import { imageExists, getImageName } from "@/lib/docker/image-builder";

export async function GET() {
  const dockerUp = await isDockerAvailable();

  let imageReady = false;
  if (dockerUp) {
    imageReady = await imageExists();
  }

  return NextResponse.json({
    docker: dockerUp,
    image: imageReady,
    imageName: getImageName(),
  });
}
```

- [ ] **Step 4: Verify build**

```bash
pnpm build
```

- [ ] **Step 5: Commit**

```bash
git add src/app/api/tasks/\[id\]/run/ src/app/api/tasks/\[id\]/cancel/ src/app/api/settings/docker/
git commit -m "feat: add run, cancel, and Docker status API routes"
```

---

### Task 11: Wire up the queue on startup

**Files:**
- Create: `src/lib/orchestrator/init.ts`
- Modify: `src/app/layout.tsx` (or create a server-side initializer)

The queue needs to start polling when the Next.js server starts. In App Router, we can use a module side-effect in a server component.

- [ ] **Step 1: Create orchestrator init**

Create `src/lib/orchestrator/init.ts`:

```typescript
import { isDockerAvailable } from "../docker/client";
import { startQueue } from "./queue";

let initialized = false;

export async function initOrchestrator(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const dockerAvailable = await isDockerAvailable();
  if (dockerAvailable) {
    console.log("[orchestrator] Docker available, starting task queue");
    startQueue();
  } else {
    console.log(
      "[orchestrator] Docker not available, running in UI-only mode (mock agent still works)"
    );
  }
}
```

- [ ] **Step 2: Create server initialization route**

Create `src/app/api/init/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { initOrchestrator } from "@/lib/orchestrator/init";

// Initialize on first request
initOrchestrator().catch(console.error);

export async function GET() {
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Call init from the root layout**

Add to `src/app/layout.tsx` — add a fetch to the init endpoint in the root layout so it fires on first page load:

At the top of `RootLayout` function (before the return), add:

```typescript
// Trigger orchestrator init on server start
if (typeof process !== "undefined" && process.env.NODE_ENV) {
  import("@/lib/orchestrator/init").then((m) => m.initOrchestrator());
}
```

Note: this is a pragmatic approach. The init module is idempotent (only runs once).

- [ ] **Step 4: Verify build**

```bash
pnpm build
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/orchestrator/init.ts src/app/api/init/ src/app/layout.tsx
git commit -m "feat: auto-start task queue when Docker is available"
```

---

### Task 12: Update settings page with Docker status

**Files:**
- Modify: `src/app/settings/page.tsx`
- Create: `src/components/docker-status.tsx`

- [ ] **Step 1: Create Docker status component**

Create `src/components/docker-status.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardContent } from "@/components/ui/card";

type DockerInfo = {
  docker: boolean;
  image: boolean;
  imageName: string;
};

export function DockerStatus() {
  const [info, setInfo] = useState<DockerInfo | null>(null);

  useEffect(() => {
    fetch("/api/settings/docker")
      .then((r) => r.json())
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  if (!info) {
    return (
      <Card>
        <CardHeader className="py-3">
          <span className="font-medium">Docker</span>
        </CardHeader>
        <CardContent className="py-2 text-sm text-muted-foreground">
          Checking...
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="py-3 flex flex-row items-center justify-between">
        <span className="font-medium">Docker</span>
        <Badge variant={info.docker ? "default" : "destructive"}>
          {info.docker ? "Connected" : "Not Available"}
        </Badge>
      </CardHeader>
      <CardContent className="py-2 text-sm space-y-1">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Agent image</span>
          <span>{info.image ? "Ready" : "Not built"}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Image name</span>
          <span className="font-mono text-xs">{info.imageName}</span>
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Add to settings page**

Modify `src/app/settings/page.tsx` — add the DockerStatus component:

```tsx
import { ProjectList } from "@/components/project-list";
import { DockerStatus } from "@/components/docker-status";

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Docker</h2>
        <DockerStatus />
      </div>
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Projects</h2>
        <ProjectList />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

```bash
pnpm build
```

- [ ] **Step 4: Commit**

```bash
git add src/components/docker-status.tsx src/app/settings/page.tsx
git commit -m "feat: add Docker status to settings page"
```

---

## Chunk 5: Integration Test

### Task 13: Update project form with git URL field

**Files:**
- Modify: `src/components/project-list.tsx`
- Modify: `src/app/api/projects/route.ts`

The projects API and settings form need to accept a `gitUrl` field so users can specify the clone URL.

- [ ] **Step 1: Update projects API POST to accept gitUrl**

In `src/app/api/projects/route.ts`, update the POST handler to include `gitUrl`:

```typescript
// In the POST handler, update the body destructuring:
const { name, githubRepo, gitUrl } = body as {
  name: string;
  githubRepo?: string;
  gitUrl?: string;
};

// And the project creation:
const project = {
  id: newId(),
  name: name.trim(),
  githubRepo: githubRepo ?? null,
  gitUrl: gitUrl ?? null,
  createdAt: new Date(),
};
```

- [ ] **Step 2: Update project list form to include git URL input**

In `src/components/project-list.tsx`, add a `gitUrl` state and input field to the create form, and send it in the POST body. Also display the git URL on project cards.

- [ ] **Step 3: Verify build**

```bash
pnpm build
```

- [ ] **Step 4: Commit**

```bash
git add src/components/project-list.tsx src/app/api/projects/route.ts
git commit -m "feat: add git URL field to project creation"
```

---

### Task 14: End-to-end integration test

No new files — this is a manual verification task. Requires Docker daemon running and valid env vars.

- [ ] **Step 1: Set up env vars**

Create `.env.local`:
```
ANTHROPIC_API_KEY=<your key>
GIT_TOKEN=<your github PAT>
```

- [ ] **Step 2: Start dev server**

```bash
pnpm dev
```

- [ ] **Step 3: Check Docker status**

```bash
curl -s http://localhost:3000/api/settings/docker
```

Should show `{"docker":true,"image":false,...}` (or `true` if image was built earlier).

- [ ] **Step 4: Create a project with git URL**

```bash
curl -s -X POST http://localhost:3000/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"name": "test-repo", "gitUrl": "https://github.com/YOUR_USER/YOUR_REPO.git"}'
```

- [ ] **Step 5: Create a task**

```bash
curl -s -X POST http://localhost:3000/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title": "Add a README.md with project description", "projectId": "PROJECT_ID"}'
```

- [ ] **Step 6: Trigger agent run**

```bash
curl -s -X POST http://localhost:3000/api/tasks/TASK_ID/run \
  -H 'Content-Type: application/json'
```

- [ ] **Step 7: Watch the stream**

```bash
curl -N http://localhost:3000/api/tasks/TASK_ID/stream
```

Should see real agent output streaming: reading files, writing code, committing.

- [ ] **Step 8: Verify branch was pushed**

After the task completes, check the repo for a new `agent/<task-id>` branch.

- [ ] **Step 9: Test cancellation**

Create another task, trigger it, then:

```bash
curl -s -X POST http://localhost:3000/api/tasks/TASK_ID/cancel
```

Verify the task status is `cancelled` and the container is removed.

- [ ] **Step 10: Commit any fixes**

If any issues were found and fixed during testing, commit them.
