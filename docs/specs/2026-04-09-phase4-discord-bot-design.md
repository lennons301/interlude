# Phase 4: Discord Bot — Design Spec

## Goal

Add a Discord bot so Sean can receive task lifecycle notifications and dispatch tasks from Discord. Each project maps to a Discord channel — new messages create tasks, replies to notifications interact with running tasks.

## Architecture

```
Discord (channel message)       Interlude (VPS)
  |                                |
  |-- new message in #lemons ----->|-- task created (queued)
  |<-- embed: "task queued" -------|
  |                                |
  |                                |-- agent picks up task
  |                                |-- agent works...
  |                                |
  |-- reply: "also add /version" ->|-- follow-up message queued
  |                                |-- agent resumes with message
  |                                |
  |                                |-- task completes
  |<-- embed: "complete, $0.08" ---|
```

**Two data flows:**

1. **Outbound (Interlude -> Discord):** Task lifecycle events (queued, completed, failed) post embeds to the project's linked Discord channel.
2. **Inbound (Discord -> Interlude):** New messages in a linked channel create tasks. Replies to task notifications deliver follow-up messages to the running agent. `cancel` as a reply cancels the task.

## Bot Setup

Discord bot using `discord.js` library, connecting via the Gateway (WebSocket) for real-time message events.

**Environment variables:**
```
DISCORD_BOT_TOKEN=<bot token from Discord Developer Portal>
DISCORD_APPLICATION_ID=<application ID>
```

**Required bot permissions:**
- Send Messages
- Read Message History
- Embed Links
- Add Reactions

**Required Gateway intents:**
- Guilds
- GuildMessages
- MessageContent (privileged — must be enabled in Developer Portal)

**Startup:** Bot connects in `initOrchestrator` if `DISCORD_BOT_TOKEN` is set. Same graceful degradation pattern as the GitHub App — when unconfigured, all notification functions are no-ops and the bot doesn't start.

## Channel-to-Project Mapping

Each project has an optional `discordChannelId` field. The mapping is established via a bot command:

1. Create a Discord channel (e.g. `#lemons`)
2. Type `!link lemons` in the channel
3. Bot looks up the project by name (case-insensitive)
4. Sets `discordChannelId` on the project record
5. Bot confirms: "Linked this channel to project **lemons**"

The channel ID is also visible (read-only) in the project edit form on the Settings page.

To unlink: `!unlink` in the channel clears the mapping.

## Outbound Notifications

Three lifecycle events trigger Discord notifications:

### Task Queued

Fires when a task is created (from Discord, GitHub webhook, or Interlude UI).

```
Task queued: Add a health check endpoint
Project: lemons
https://interludes.co.uk/tasks/01KN...
```

The bot stores the Discord message ID of this notification on the task record (`discordMessageId`). This is how replies get mapped back to tasks.

### Task Completed

Fires when `completeTask()` succeeds.

```
Task complete: Add a health check endpoint
Cost: $0.08
PR: https://github.com/lennons301/lemons/pull/18
https://interludes.co.uk/tasks/01KN...
```

PR link included only if the task has a linked GitHub issue/PR.

### Task Failed

Fires when a task enters `failed` status (setup error, runtime error, push failure).

```
Task failed: Add a health check endpoint
Error: Container setup timeout
https://interludes.co.uk/tasks/01KN...
```

### What's NOT Notified

- Turn-by-turn progress (too noisy)
- Dev server online (minor detail)
- Agent started (queued notification is sufficient)
- Task cancelled (the user initiated it, they already know)

## Inbound Message Handling

The bot listens for `messageCreate` events on the Gateway and routes them based on context:

### New Message (not a reply) in Linked Channel

Creates a task:
1. Look up project by `discordChannelId`
2. Message content becomes the task title (first line) and description (rest)
3. Insert task with `status: "queued"` — queue picks it up on next poll
4. Post "task queued" embed as reply, store the message ID on the task

### Reply to a Task Notification

Delivers a follow-up message to the running agent:
1. Look up task by `discordMessageId` matching the replied-to message
2. If task is running: insert user message with `deliveredAt: null` (same as chat UI POST)
3. If message text is `cancel` (case-insensitive): cancel the task instead
4. If task is terminal (completed/failed/cancelled): bot reacts with an indicator and ignores

### `!link <project-name>` Command

Maps the channel to a project:
1. Parse project name from message
2. Look up project by name (case-insensitive)
3. If found: set `discordChannelId`, confirm with message
4. If not found: reply with error

### `!unlink` Command

Clears the channel mapping:
1. Find project with this `discordChannelId`
2. Clear the field
3. Confirm with message

### Bot's Own Messages

The bot ignores its own messages (standard `message.author.bot` check).

## Schema Changes

**Projects table — new field:**
```
discordChannelId: text("discord_channel_id")
```

**Tasks table — new field:**
```
discordMessageId: text("discord_message_id")
```

## New Files

```
src/lib/discord/
  client.ts         — Bot setup, Gateway connection, message event routing
  notifications.ts  — Post embeds to channels (queued, complete, failed)
```

## Integration Points (Existing Code Changes)

**`src/lib/config.ts`:**
- Add `discordBotToken: string | null` and `discordApplicationId: string | null`

**`src/lib/orchestrator/init.ts`:**
- Start Discord bot if token configured, log status

**`src/lib/orchestrator/turn-manager.ts`:**
- `startTask()` after task is queued/running: call notification for "task queued"
- `completeTask()`: call notification for "task complete"
- Error catch blocks in `startTask()` and `completeTask()`: call notification for "task failed"
- Fire-and-forget with `.catch(console.error)` — same pattern as GitHub comments

**`src/db/schema.ts`:**
- Add `discordChannelId` to projects
- Add `discordMessageId` to tasks

**`src/lib/orchestrator/turn-manager.ts` (updateTask):**
- Add `discordMessageId` to the fields type

**`src/components/project-list.tsx`:**
- Show `discordChannelId` in project edit form (read-only display, set via bot command)

**`.env.example`:**
- Add Discord bot token and application ID

## Config Changes

All nullable — Discord integration is optional.

```typescript
discordBotToken: string | null;       // DISCORD_BOT_TOKEN
discordApplicationId: string | null;  // DISCORD_APPLICATION_ID
```

## What This Phase Does NOT Include

- **Thread-based conversations** — replies happen in the channel, not Discord threads. Keeps it simple.
- **Rich slash commands** — natural message parsing only. No Discord command registration.
- **Multi-server support** — single Discord server, single user.
- **Notification preferences per project** — all linked projects get notifications. No granular control.
- **Message editing** — bot posts new messages, doesn't edit previous ones (e.g. updating "queued" to "running").

## Discord App Registration

Manual setup steps:
1. Go to https://discord.com/developers/applications
2. Create new application (e.g. "Interlude")
3. Go to Bot tab, create bot
4. Enable "Message Content Intent" under Privileged Gateway Intents
5. Copy bot token → `DISCORD_BOT_TOKEN`
6. Copy application ID → `DISCORD_APPLICATION_ID`
7. Generate invite URL with permissions: Send Messages, Read Message History, Embed Links, Add Reactions
8. Invite bot to your Discord server
9. Add env vars to VPS `/opt/interlude/.env`
