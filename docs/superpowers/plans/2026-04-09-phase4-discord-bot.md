# Phase 4: Discord Bot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Discord bot that posts task lifecycle notifications (queued, completed, failed) to project-linked channels and accepts inbound messages to create tasks and send follow-ups.

**Architecture:** Discord bot connects via Gateway (WebSocket) using discord.js. Outbound notifications are fire-and-forget calls from the turn manager. Inbound messages create tasks or deliver follow-ups via the same DB paths as the webhook and chat UI. Each project maps to a Discord channel via `!link` command.

**Tech Stack:** discord.js, Next.js App Router, Drizzle ORM (SQLite)

**Spec:** `docs/specs/2026-04-09-phase4-discord-bot-design.md`

---

## File Structure

```
src/lib/discord/
  client.ts              — NEW: Bot setup, Gateway connection, message event routing
  notifications.ts       — NEW: Post embeds to channels (queued, complete, failed)

src/db/schema.ts                      — MODIFY: add discordChannelId to projects, discordMessageId to tasks
src/lib/config.ts                     — MODIFY: add discordBotToken, discordApplicationId
src/lib/orchestrator/init.ts          — MODIFY: start bot if configured, log status
src/lib/orchestrator/turn-manager.ts  — MODIFY: call notifications at lifecycle points
src/components/project-list.tsx       — MODIFY: show discordChannelId in edit form (read-only)
.env.example                          — MODIFY: add Discord env vars
```

---

## Task 1: Install Dependencies + Schema + Config

**Files:**
- Modify: `package.json`
- Modify: `src/db/schema.ts`
- Modify: `src/lib/config.ts`
- Modify: `.env.example`

- [ ] **Step 1: Install discord.js**

```bash
pnpm add discord.js
```

- [ ] **Step 2: Add `discordChannelId` to projects schema**

In `src/db/schema.ts`, add after `dopplerToken` (line 8):

```typescript
  discordChannelId: text("discord_channel_id"),
```

- [ ] **Step 3: Add `discordMessageId` to tasks schema**

In `src/db/schema.ts`, add after `pullRequestUrl` (line 36):

```typescript
  discordMessageId: text("discord_message_id"),
```

- [ ] **Step 4: Add Discord config fields**

In `src/lib/config.ts`, add to the `AppConfig` interface after the GitHub fields (after line 28):

```typescript
  /** Discord bot token (from Developer Portal) */
  discordBotToken: string | null;
  /** Discord application ID */
  discordApplicationId: string | null;
```

In the `getConfig()` return object, after `githubAppInstallationId` (after line 81):

```typescript
    discordBotToken: process.env.DISCORD_BOT_TOKEN ?? null,
    discordApplicationId: process.env.DISCORD_APPLICATION_ID ?? null,
```

- [ ] **Step 5: Update .env.example**

Add to `.env.example`:

```
# Discord Bot (optional — enables task notifications + dispatch from Discord)
# DISCORD_BOT_TOKEN=your-bot-token
# DISCORD_APPLICATION_ID=your-application-id
```

- [ ] **Step 6: Build to verify**

```bash
pnpm build
```

Expected: Build passes.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml src/db/schema.ts src/lib/config.ts .env.example
git commit -m "feat: add discord.js dep, schema fields, and config for Discord bot"
```

---

## Task 2: Discord Notification Helpers

Create the outbound notification module. These functions post embeds to a project's linked Discord channel.

**Files:**
- Create: `src/lib/discord/notifications.ts`

- [ ] **Step 1: Create the notifications module**

Create `src/lib/discord/notifications.ts`:

```typescript
import { Client, EmbedBuilder, TextChannel } from "discord.js";

let botClient: Client | null = null;

/** Called by client.ts once the bot is ready */
export function setBotClient(client: Client): void {
  botClient = client;
}

export function getBotClient(): Client | null {
  return botClient;
}

/**
 * Post a "task queued" notification. Returns the Discord message ID
 * so it can be stored on the task for reply mapping.
 */
export async function notifyTaskQueued(
  channelId: string,
  task: { id: string; title: string; projectName: string }
): Promise<string | null> {
  if (!botClient) return null;

  try {
    const channel = await botClient.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return null;

    const domain = process.env.DOMAIN ?? "interludes.co.uk";
    const embed = new EmbedBuilder()
      .setTitle(`Task queued: ${task.title}`)
      .setDescription(`Project: ${task.projectName}`)
      .setURL(`https://${domain}/tasks/${task.id}`)
      .setColor(0x7B61FF);

    const msg = await (channel as TextChannel).send({ embeds: [embed] });
    return msg.id;
  } catch (err) {
    console.error(`[discord] Failed to send queued notification:`, err);
    return null;
  }
}

/**
 * Post a "task completed" notification.
 */
export async function notifyTaskCompleted(
  channelId: string,
  task: {
    id: string;
    title: string;
    totalCostUsd: number;
    pullRequestUrl: string | null;
  }
): Promise<void> {
  if (!botClient) return;

  try {
    const channel = await botClient.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return;

    const domain = process.env.DOMAIN ?? "interludes.co.uk";
    const cost = task.totalCostUsd.toFixed(2);

    const embed = new EmbedBuilder()
      .setTitle(`Task complete: ${task.title}`)
      .setURL(`https://${domain}/tasks/${task.id}`)
      .setColor(0x22C55E);

    const lines = [`Cost: $${cost}`];
    if (task.pullRequestUrl) {
      lines.push(`PR: ${task.pullRequestUrl}`);
    }
    embed.setDescription(lines.join("\n"));

    await (channel as TextChannel).send({ embeds: [embed] });
  } catch (err) {
    console.error(`[discord] Failed to send completed notification:`, err);
  }
}

/**
 * Post a "task failed" notification.
 */
export async function notifyTaskFailed(
  channelId: string,
  task: { id: string; title: string; error: string }
): Promise<void> {
  if (!botClient) return;

  try {
    const channel = await botClient.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return;

    const domain = process.env.DOMAIN ?? "interludes.co.uk";
    const embed = new EmbedBuilder()
      .setTitle(`Task failed: ${task.title}`)
      .setDescription(`Error: ${task.error}`)
      .setURL(`https://${domain}/tasks/${task.id}`)
      .setColor(0xEF4444);

    await (channel as TextChannel).send({ embeds: [embed] });
  } catch (err) {
    console.error(`[discord] Failed to send failed notification:`, err);
  }
}
```

- [ ] **Step 2: Build to verify**

```bash
pnpm build
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/discord/notifications.ts
git commit -m "feat: Discord notification helpers (queued, completed, failed)"
```

---

## Task 3: Discord Bot Client

Create the bot client that connects to Discord Gateway and routes inbound messages.

**Files:**
- Create: `src/lib/discord/client.ts`

- [ ] **Step 1: Create the bot client module**

Create `src/lib/discord/client.ts`:

```typescript
import { Client, GatewayIntentBits, Message } from "discord.js";
import { db } from "@/db";
import { projects, tasks, messages } from "@/db/schema";
import { eq } from "drizzle-orm";
import { newId } from "../ulid";
import { getConfig } from "../config";
import { setBotClient, notifyTaskQueued } from "./notifications";

let client: Client | null = null;

export function isDiscordConfigured(): boolean {
  const config = getConfig();
  return !!(config.discordBotToken && config.discordApplicationId);
}

export async function startDiscordBot(): Promise<void> {
  const config = getConfig();
  if (!config.discordBotToken) {
    throw new Error("DISCORD_BOT_TOKEN not configured");
  }

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.on("ready", () => {
    console.log(`[discord] Bot connected as ${client!.user?.tag}`);
    setBotClient(client!);
  });

  client.on("messageCreate", (message) => {
    handleMessage(message).catch((err) =>
      console.error("[discord] Message handler error:", err)
    );
  });

  await client.login(config.discordBotToken);
}

async function handleMessage(message: Message): Promise<void> {
  // Ignore bot messages
  if (message.author.bot) return;

  const content = message.content.trim();
  if (!content) return;

  // Handle !link command
  if (content.startsWith("!link ")) {
    await handleLinkCommand(message, content.slice(6).trim());
    return;
  }

  // Handle !unlink command
  if (content === "!unlink") {
    await handleUnlinkCommand(message);
    return;
  }

  // Check if this channel is linked to a project
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.discordChannelId, message.channelId))
    .get();

  if (!project) return; // Not a linked channel, ignore

  // Check if this is a reply to a task notification
  if (message.reference?.messageId) {
    await handleReply(message, project);
    return;
  }

  // New message in linked channel — create a task
  await handleNewTask(message, project);
}

async function handleLinkCommand(message: Message, projectName: string): Promise<void> {
  if (!projectName) {
    await message.reply("Usage: `!link <project-name>`");
    return;
  }

  // Case-insensitive project lookup
  const allProjects = db.select().from(projects).all();
  const project = allProjects.find(
    (p) => p.name.toLowerCase() === projectName.toLowerCase()
  );

  if (!project) {
    await message.reply(`Project **${projectName}** not found.`);
    return;
  }

  db.update(projects)
    .set({ discordChannelId: message.channelId })
    .where(eq(projects.id, project.id))
    .run();

  await message.reply(`Linked this channel to project **${project.name}**`);
  console.log(`[discord] Channel ${message.channelId} linked to project ${project.name}`);
}

async function handleUnlinkCommand(message: Message): Promise<void> {
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.discordChannelId, message.channelId))
    .get();

  if (!project) {
    await message.reply("This channel is not linked to any project.");
    return;
  }

  db.update(projects)
    .set({ discordChannelId: null })
    .where(eq(projects.id, project.id))
    .run();

  await message.reply(`Unlinked from project **${project.name}**`);
  console.log(`[discord] Channel ${message.channelId} unlinked from project ${project.name}`);
}

async function handleNewTask(
  message: Message,
  project: { id: string; name: string }
): Promise<void> {
  const content = message.content.trim();

  // First line is title, rest is description
  const lines = content.split("\n");
  const title = lines[0].trim();
  const description = lines.slice(1).join("\n").trim();

  const taskId = newId();
  const now = new Date();

  db.insert(tasks)
    .values({
      id: taskId,
      projectId: project.id,
      title,
      description,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  // Post queued notification and store the message ID
  const discordMessageId = await notifyTaskQueued(message.channelId, {
    id: taskId,
    title,
    projectName: project.name,
  });

  if (discordMessageId) {
    db.update(tasks)
      .set({ discordMessageId, updatedAt: new Date() })
      .where(eq(tasks.id, taskId))
      .run();
  }

  console.log(`[discord] Message in #${message.channel} -> task ${taskId} (queued)`);
}

async function handleReply(
  message: Message,
  project: { id: string; name: string }
): Promise<void> {
  const repliedToId = message.reference!.messageId!;

  // Find the task this reply is for
  const task = db
    .select()
    .from(tasks)
    .where(eq(tasks.discordMessageId, repliedToId))
    .get();

  if (!task) return; // Reply to something that isn't a task notification

  // Handle "cancel" command
  if (message.content.trim().toLowerCase() === "cancel") {
    if (["completed", "failed", "cancelled"].includes(task.status)) {
      await message.react("❌");
      return;
    }
    // Import cancelTask dynamically to avoid circular dependency
    const { cancelTask } = await import("../orchestrator/turn-manager");
    await cancelTask(task.id);
    await message.react("🛑");
    console.log(`[discord] Task ${task.id} cancelled via Discord reply`);
    return;
  }

  // Check if task is in a terminal state
  if (["completed", "failed", "cancelled"].includes(task.status)) {
    await message.react("❌");
    return;
  }

  // Insert as user message — queue will pick it up
  db.insert(messages)
    .values({
      id: newId(),
      taskId: task.id,
      role: "user",
      type: "text",
      content: JSON.stringify({ text: message.content.trim() }),
      createdAt: new Date(),
    })
    .run();

  await message.react("👍");
  console.log(`[discord] Follow-up message for task ${task.id} from Discord`);
}
```

- [ ] **Step 2: Build to verify**

```bash
pnpm build
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/discord/client.ts
git commit -m "feat: Discord bot client with message routing, task creation, and follow-ups"
```

---

## Task 4: Turn Manager Integration — Notifications at Lifecycle Points

**Files:**
- Modify: `src/lib/orchestrator/turn-manager.ts`

- [ ] **Step 1: Add import for Discord notifications**

At the top of `src/lib/orchestrator/turn-manager.ts`, after the GitHub imports (line 18-19), add:

```typescript
import { notifyTaskQueued, notifyTaskCompleted, notifyTaskFailed } from "../discord/notifications";
```

- [ ] **Step 2: Add `discordMessageId` to `updateTask` type**

In the `updateTask` function (line 463), add to the `fields` type after `pullRequestUrl: string | null;` (line 476):

```typescript
    discordMessageId: string | null;
```

- [ ] **Step 3: Add "task queued" notification in `startTask`**

In `startTask()`, after `updateTask(taskId, { status: "running", branch, containerStatus: "setup" });` (line 61) and before `let running`, add:

```typescript
  // Notify Discord channel that task is queued
  if (proj.discordChannelId) {
    notifyTaskQueued(proj.discordChannelId, {
      id: taskId,
      title: task.title,
      projectName: proj.name,
    }).then((msgId) => {
      if (msgId) updateTask(taskId, { discordMessageId: msgId });
    }).catch(console.error);
  }
```

Note: This is for tasks created via the Interlude UI or GitHub webhook — tasks created from Discord already have their notification posted in `client.ts`.

- [ ] **Step 4: Add "task completed" notification in `completeTask`**

In `completeTask()`, after `updateTask(taskId, { status: "completed", containerStatus: null });` (line 298), add:

```typescript
    // Notify Discord
    if (proj) {
      const projData = db.select().from(projects).where(eq(projects.id, task.projectId)).get();
      if (projData?.discordChannelId) {
        notifyTaskCompleted(projData.discordChannelId, {
          id: taskId,
          title: task.title,
          totalCostUsd: task.totalCostUsd ?? 0,
          pullRequestUrl: task.pullRequestUrl ?? null,
        }).catch(console.error);
      }
    }
```

- [ ] **Step 5: Add "task failed" notification in `startTask` catch block**

In `startTask()`'s catch block, after the GitHub comment block (after line 126), add:

```typescript
    const projData = db.select().from(projects).where(eq(projects.id, task.projectId)).get();
    if (projData?.discordChannelId) {
      notifyTaskFailed(projData.discordChannelId, {
        id: taskId,
        title: task.title,
        error: err instanceof Error ? err.message : String(err),
      }).catch(console.error);
    }
```

- [ ] **Step 6: Add "task failed" notification in `completeTask` catch block**

In `completeTask()`'s catch block, after the GitHub comment block (after line 311), add:

```typescript
    const projForNotify = db.select().from(projects).where(eq(projects.id, task.projectId)).get();
    if (projForNotify?.discordChannelId) {
      notifyTaskFailed(projForNotify.discordChannelId, {
        id: taskId,
        title: task.title,
        error: err instanceof Error ? err.message : String(err),
      }).catch(console.error);
    }
```

- [ ] **Step 7: Build to verify**

```bash
pnpm build
```

- [ ] **Step 8: Commit**

```bash
git add src/lib/orchestrator/turn-manager.ts
git commit -m "feat: Discord notifications at task lifecycle points (queued, completed, failed)"
```

---

## Task 5: Startup Integration

**Files:**
- Modify: `src/lib/orchestrator/init.ts`

- [ ] **Step 1: Add imports**

In `src/lib/orchestrator/init.ts`, after the GitHub import (line 7), add:

```typescript
import { isDiscordConfigured, startDiscordBot } from "../discord/client";
```

- [ ] **Step 2: Start bot and log status**

In `initOrchestrator`, after the GitHub status log block (after line 114), add:

```typescript
    if (isDiscordConfigured()) {
      startDiscordBot()
        .then(() => console.log("[orchestrator] Discord bot started"))
        .catch((err) => console.error("[orchestrator] Discord bot failed to start:", err));
    } else {
      console.log("[orchestrator] Discord bot not configured -- running without Discord integration");
    }
```

- [ ] **Step 3: Build to verify**

```bash
pnpm build
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/orchestrator/init.ts
git commit -m "feat: start Discord bot on orchestrator init if configured"
```

---

## Task 6: Project Edit UI — Show Discord Channel ID

**Files:**
- Modify: `src/components/project-list.tsx`

- [ ] **Step 1: Add `discordChannelId` to the `Project` type**

In `src/components/project-list.tsx`, add to the `Project` type (after `dopplerToken: string | null;` line 13):

```typescript
  discordChannelId: string | null;
```

- [ ] **Step 2: Display Discord channel ID in the edit form**

In the `ProjectEditForm` component, after the Doppler Token field (after the closing `</div>` of the Doppler input, around line 177), add:

```tsx
        {project.discordChannelId && (
          <div>
            <label className="text-xs text-muted-foreground">
              Discord Channel <span className="text-green-400">(linked)</span>
            </label>
            <Input
              value={project.discordChannelId}
              disabled
              className="font-mono text-xs opacity-60"
            />
          </div>
        )}
```

- [ ] **Step 3: Build to verify**

```bash
pnpm build
```

- [ ] **Step 4: Commit**

```bash
git add src/components/project-list.tsx
git commit -m "feat: show Discord channel ID in project edit form"
```

---

## Task 7: Discord App Registration + VPS Deploy

This task is manual setup — no code changes.

- [ ] **Step 1: Create Discord Application**

Go to https://discord.com/developers/applications:
- Click "New Application"
- Name: "Interlude"
- Go to **Bot** tab
- Click "Reset Token" and copy it → this is `DISCORD_BOT_TOKEN`
- Enable **Message Content Intent** under Privileged Gateway Intents
- Copy the Application ID from the General Information tab → this is `DISCORD_APPLICATION_ID`

- [ ] **Step 2: Generate invite URL and add bot to server**

Go to **OAuth2** > **URL Generator**:
- Scopes: `bot`
- Bot Permissions: Send Messages, Read Message History, Embed Links, Add Reactions
- Copy the generated URL and open it to invite the bot to your Discord server

- [ ] **Step 3: Create project channels in Discord**

Create a channel for each project you want to link (e.g. `#lemons`).

- [ ] **Step 4: Add env vars to VPS**

SSH to VPS and add to `/opt/interlude/.env`:

```bash
DISCORD_BOT_TOKEN=<your-bot-token>
DISCORD_APPLICATION_ID=<your-application-id>
```

- [ ] **Step 5: Run DB migration on VPS**

```bash
ssh deploy@178.104.72.109 "docker exec interlude-app-1 node -e \"const D=require('better-sqlite3');const db=new D('/data/interlude.db');db.exec('ALTER TABLE projects ADD COLUMN discord_channel_id TEXT; ALTER TABLE tasks ADD COLUMN discord_message_id TEXT;');console.log('done')\""
```

- [ ] **Step 6: Push code and deploy**

```bash
git push origin main
```

Wait for CI/CD to deploy, then restart to pick up new env vars:

```bash
ssh deploy@178.104.72.109 "cd /opt/interlude && docker compose up -d --force-recreate app"
```

- [ ] **Step 7: Verify startup logs**

```bash
ssh deploy@178.104.72.109 "cd /opt/interlude && docker compose logs app --tail=20"
```

Expected: `[orchestrator] Discord bot started` and `[discord] Bot connected as Interlude#XXXX`

---

## Task 8: E2E Verification

- [ ] **Step 1: Link a channel to a project**

In your Discord server's `#lemons` channel, type:

```
!link lemons
```

Expected: Bot replies "Linked this channel to project **lemons**"

- [ ] **Step 2: Create a task from Discord**

Type in `#lemons`:

```
Add a /api/version endpoint that returns the git commit SHA
```

Expected:
- Bot posts a "Task queued" embed with purple sidebar
- Task appears in Interlude UI at the link in the embed
- Agent picks it up and starts working

- [ ] **Step 3: Send a follow-up message**

Reply to the "Task queued" embed:

```
also return the current timestamp
```

Expected: Bot reacts with 👍, message delivered to agent on next idle poll

- [ ] **Step 4: Verify completion notification**

Wait for the task to complete. Expected:
- Bot posts a "Task complete" embed with green sidebar, cost, and PR link

- [ ] **Step 5: Test cancel**

Create another task, then reply to its queued embed with:

```
cancel
```

Expected: Bot reacts with 🛑, task cancelled in Interlude

- [ ] **Step 6: Test failure notification**

Verify that if a task fails (e.g. no git URL configured), bot posts a "Task failed" embed with red sidebar.

---

## Task 9: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update status and roadmap**

Change "Phase 3 complete" to "Phase 4 complete" in the `## Current Status` heading.

Update the Phase 4 section in the roadmap:

```markdown
### Phase 4: Discord Bot (done)
- Discord bot via discord.js Gateway for bidirectional messaging
- Channel-per-project mapping via `!link` command
- Outbound: task queued/completed/failed notifications as rich embeds
- Inbound: new messages create tasks, replies deliver follow-ups or cancel
- Spec: `docs/specs/2026-04-09-phase4-discord-bot-design.md`
- Plan: `docs/superpowers/plans/2026-04-09-phase4-discord-bot.md`
```

Add to Key Conventions:
- Discord bot provides channel-per-project task dispatch and lifecycle notifications
- Discord config is optional — all features degrade gracefully when unconfigured

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: mark Phase 4 complete, update conventions"
```
