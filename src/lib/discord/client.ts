import { Client, GatewayCloseCodes, GatewayIntentBits, Message, Partials } from "discord.js";
import type { MessageReaction, PartialMessageReaction, User, PartialUser } from "discord.js";
import { db } from "@/db";
import { projects, tasks, messages } from "@/db/schema";
import { eq } from "drizzle-orm";
import { newId } from "../ulid";
import { getConfig } from "../config";
import { isArmingConfirmation } from "../orchestrator/autonomy/triage";
import { setBotClient, notifyTaskQueued } from "./notifications";
import {
  recordDiscordConnected,
  recordDiscordGatewayClosed,
  recordDiscordInbound,
} from "./gateway-health";
import { existingAnswers, insertDiscordAnswer } from "./blocked-replies";

/**
 * The gateway is the only way anything reaches Interlude *from* Discord, and
 * until issue #135 nothing watched it: `clientReady` was the one lifecycle
 * event handled, a dead session sat deaf, and a handler that threw swallowed
 * the human's reply into `console.error`. Now every lifecycle event is logged
 * with its shard and close code, every delivered event advances the inbound
 * clock the fleet-health watchdog reads (`gateway-health.ts`), a shard the
 * library has given up on raises the deaf-gateway card at once with the fix
 * named, and a handler failure leaves a trace the human can see — a ⚠️ on their
 * message and a system message on the task it was for.
 *
 * What the lifecycle events mean is a fact about discord.js 14.26.4, checked
 * against its source rather than its docs. `@discordjs/ws` handles
 * INVALID_SESSION and RECONNECT itself (resume, or re-identify), announced as
 * `shardReconnecting`. `shardDisconnect` is emitted **only** for a close code
 * in `UNRECOVERABLE_CLOSE_CODES` — 4004 authentication failed, 4010–4014
 * (invalid shard, sharding required, invalid API version, invalid or
 * disallowed intents) — every one a configuration error that logging in again
 * with the same token and intents would only repeat. So nothing here
 * re-logs-in: a re-login loop on those codes would IDENTIFY toward Discord's
 * daily limit (which resets the token) and fix nothing. The remedy is a config
 * change and a restart, and the card says so. `invalidated`, the event the
 * ticket names, exists in the `Events` enum but is never emitted by this
 * version; it is logged if it ever arrives.
 */

/** What `startDiscordBot` needs from the outside world — injectable so the
 * gateway wiring can be driven by a fake client in tests. */
export interface DiscordBotDeps {
  createClient: () => Client;
}

const DEFAULT_DEPS: DiscordBotDeps = {
  createClient: () =>
    new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Message, Partials.Reaction, Partials.Channel],
    }),
};

let deps: DiscordBotDeps = DEFAULT_DEPS;

export function isDiscordConfigured(): boolean {
  const config = getConfig();
  return !!(config.discordBotToken && config.discordApplicationId);
}

export async function startDiscordBot(overrides: Partial<DiscordBotDeps> = {}): Promise<void> {
  const config = getConfig();
  if (!config.discordBotToken) {
    throw new Error("DISCORD_BOT_TOKEN not configured");
  }
  deps = { ...DEFAULT_DEPS, ...overrides };
  const c = deps.createClient();
  wireGateway(c);
  await c.login(config.discordBotToken);
}

function wireGateway(c: Client): void {
  c.on("clientReady", () => {
    console.log(`[discord] Bot connected as ${c.user?.tag}`);
    recordDiscordConnected();
    setBotClient(c);
  });

  // Lifecycle (issue #135). Each is logged with what discord.js knows, and each
  // arrival counts as the gateway being alive. A recoverable close is the
  // library's to handle (`shardReconnecting`, then `shardResume` or a fresh
  // `shardReady`); an unrecoverable one (`shardDisconnect`) is a configuration
  // error only a human can fix, so it is recorded for the watchdog, not retried.
  c.on("shardReady", (shardId, unavailable) => {
    recordDiscordInbound();
    console.log(
      `[discord] Shard ${shardId} ready` +
        (unavailable?.size ? ` (${unavailable.size} guild(s) unavailable)` : "")
    );
  });
  c.on("shardResume", (shardId, replayedEvents) => {
    recordDiscordInbound();
    console.log(`[discord] Shard ${shardId} resumed, ${replayedEvents} event(s) replayed`);
  });
  c.on("shardReconnecting", (shardId) => {
    console.warn(
      `[discord] Shard ${shardId} reconnecting — a recoverable close; discord.js resumes ` +
        `or re-identifies by itself`
    );
  });
  c.on("shardDisconnect", (event, shardId) => {
    // Emitted only when the library will not reconnect this shard (an
    // unrecoverable close code such as 4004 authentication failed or 4014
    // disallowed intents): inbound is dead from here. Outbound REST still
    // works, so the deaf-gateway card and its ping — raised on the next sweep,
    // no threshold — reach the owner with the code and the fix.
    recordDiscordGatewayClosed(event.code);
    console.error(
      `[discord] Shard ${shardId} disconnected with unrecoverable close code ` +
        `${event.code} (${closeCodeName(event.code)}) — discord.js will not reconnect it, ` +
        `and re-logging in with the same token and intents would only repeat it. ` +
        `Fix the bot's configuration (token, intents) and restart the app.`
    );
  });
  c.on("shardError", (err, shardId) => {
    console.error(`[discord] Shard ${shardId} error:`, err);
  });
  c.on("error", (err) => {
    console.error("[discord] Client error:", err);
  });
  // Not emitted by discord.js 14.26.4 (verified in its WebSocketManager: the
  // enum entry exists, nothing emits it). Logged in case a future version does,
  // so the change of behaviour is at least visible.
  c.on("invalidated", () => {
    console.error(
      "[discord] Client reported its session invalidated — not expected from this " +
        "discord.js version; if replies stop arriving, the fleet-health card says so"
    );
  });

  c.on("messageCreate", (message) => {
    recordDiscordInbound();
    handleMessage(message).catch((err) => reportDiscordHandlerFailure(message, err));
  });

  c.on("messageReactionAdd", (reaction, user) => {
    recordDiscordInbound();
    handleReactionAdd(reaction, user).catch((err) =>
      console.error("[discord] Reaction handler error:", err)
    );
  });
}

/** The gateway close code's name, for the log line. */
function closeCodeName(code: number): string {
  return GatewayCloseCodes[code] ?? "unknown";
}

/** What the failure report needs of a message, so a test can hand in a stub. */
export interface FailedMessage {
  id: string;
  reference: { messageId?: string | null } | null;
  react(emoji: string): Promise<unknown>;
}

/**
 * A handler that threw used to swallow the human's message into a log line
 * they will never read (issue #135). Silence is the one outcome a human cannot
 * act on, so: a ⚠️ on their message, best-effort, and — when the message was a
 * reply to a task's embed — a system message on that task saying what happened,
 * so the task page tells the same story as the channel.
 *
 * What happened depends on whether the reply's row exists. A throw before the
 * insert means nothing was delivered and the human should reply again; a throw
 * after it (the likeliest is the 👍 REST call — now best-effort in `handleReply`,
 * but the check stays because this is the last line of defence) means the
 * answer *is* on its way and telling them to reply again would cost a second
 * turn. The row is looked up by the Discord message id both paths record.
 */
export async function reportDiscordHandlerFailure(
  message: FailedMessage,
  err: unknown
): Promise<void> {
  console.error(`[discord] Message handler error (message ${message.id}):`, err);
  try {
    await message.react("⚠️");
  } catch (reactErr) {
    console.error(`[discord] Could not mark failed message ${message.id}:`, reactErr);
  }

  const repliedToId = message.reference?.messageId;
  if (!repliedToId) return;
  try {
    const task = db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.discordMessageId, repliedToId))
      .get();
    if (!task) return;
    const reason = err instanceof Error ? err.message : String(err);
    const recorded = existingAnswers(task.id).some((a) => a.discordMessageId === message.id);
    db.insert(messages)
      .values({
        id: newId(),
        taskId: task.id,
        role: "system",
        type: "system",
        content: recorded
          ? `Your Discord reply was recorded and will be delivered, but marking it in ` +
            `Discord failed (${reason}) — no need to reply again.`
          : `A Discord reply to this task was seen but could not be processed (${reason}). ` +
            `Nothing was delivered to the agent — reply again in Discord, or answer here.`,
        createdAt: new Date(),
      })
      .run();
  } catch (traceErr) {
    console.error(`[discord] Could not record the failed reply on its task:`, traceErr);
  }
}

async function handleMessage(message: Message): Promise<void> {
  // Ignore bot messages
  if (message.author.bot) return;

  const content = message.content.trim();
  if (!content) return;

  // Handle !link command (with or without an argument — bare "!link" shows usage)
  if (content === "!link" || content.startsWith("!link ")) {
    await handleLinkCommand(message, content.slice("!link".length).trim());
    return;
  }

  // Handle !unlink command
  if (content === "!unlink") {
    await handleUnlinkCommand(message);
    return;
  }

  // A reply routes to its task from any channel the bot can read — a blocked
  // run's question may live in the fleet channel, which is linked to no
  // project. Replies to non-task messages are ignored as before.
  if (message.reference?.messageId) {
    await handleReply(message);
    return;
  }

  // Check if this channel is linked to a project
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.discordChannelId, message.channelId))
    .get();

  if (!project) return; // Not a linked channel, ignore

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

  // Post the queued notification BEFORE inserting the task row. The queue
  // poller picks up any "queued" task within ~2s and startTask will post its
  // own queued embed unless discordMessageId is already set — so the row must
  // carry discordMessageId from the moment it exists, or we get a duplicate
  // embed. taskId is a client-side ULID, so it's valid to reference before insert.
  const discordMessageId = await notifyTaskQueued(message.channelId, {
    id: taskId,
    title,
    projectName: project.name,
  });

  const now = new Date();
  db.insert(tasks)
    .values({
      id: taskId,
      projectId: project.id,
      title,
      description,
      status: "queued",
      discordMessageId: discordMessageId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  console.log(`[discord] Message in #${message.channel} -> task ${taskId} (queued)`);
}

async function handleReply(message: Message): Promise<void> {
  const repliedToId = message.reference!.messageId!;

  // Find the task this reply is for
  const task = db
    .select()
    .from(tasks)
    .where(eq(tasks.discordMessageId, repliedToId))
    .get();

  if (!task) return; // Reply to something that isn't a task notification

  // A reply to a triage recommendation is an arming decision, not a task
  // follow-up: an explicit yes applies ready-for-agent through the
  // orchestrator — a human's confirmation is the one thing arming may trace
  // to. Anything else is conversation, and silence is never consent.
  if (task.kind === "triage") {
    await handleArmingConfirmation(message, task);
    return;
  }

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

  // Insert as user message — queue will pick it up. Through the one helper the
  // REST reconciliation also uses (issue #135), so the Discord message id is on
  // the row and neither path can deliver what the other already has.
  const inserted = insertDiscordAnswer(task.id, message.content, message.id);
  console.log(
    `[discord] Follow-up message for task ${task.id} from Discord` +
      (inserted ? "" : " (already adopted over REST)")
  );
  // Best-effort: the row is the delivery, the 👍 is only the receipt. A REST
  // failure here must not read as "nothing was delivered" (issue #135).
  try {
    await message.react("👍");
  } catch (err) {
    console.error(`[discord] Could not acknowledge reply ${message.id} for task ${task.id}:`, err);
  }
}

async function handleArmingConfirmation(
  message: Message,
  task: { id: string; githubIssue: string | null }
): Promise<void> {
  if (!task.githubIssue) return;
  if (!isArmingConfirmation(message.content)) return;

  // Dynamic import to avoid circular dependency with the orchestrator
  const { armIssueFromDiscord } = await import("../orchestrator/autonomy/sweep");
  const armed = await armIssueFromDiscord(task.githubIssue, message.author.tag);
  await message.react(armed ? "✅" : "❌");
  if (armed) {
    console.log(`[discord] ${task.githubIssue} armed via reply by ${message.author.tag}`);
  }
}

async function handleReactionAdd(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser
): Promise<void> {
  if (user.bot) return;

  // Resolve partials (message/reaction may be uncached, e.g. after a restart)
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch {
      return;
    }
  }

  if (reaction.emoji.name !== "✅") return;

  const messageId = reaction.message.id;
  const task = db.select().from(tasks).where(eq(tasks.discordMessageId, messageId)).get();
  if (!task) return; // Reaction not on a task's interactive message

  if (task.status !== "running") return; // Only running/idle tasks can be completed

  // Dynamic import to avoid circular dependency with turn-manager
  const { completeTask } = await import("../orchestrator/turn-manager");
  await completeTask(task.id);
  console.log(`[discord] Task ${task.id} completed via ✅ reaction`);
}
