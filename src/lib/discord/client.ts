import { Client, GatewayIntentBits, Message, Partials } from "discord.js";
import type { MessageReaction, PartialMessageReaction, User, PartialUser } from "discord.js";
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
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Reaction, Partials.Channel],
  });

  client.on("clientReady", () => {
    console.log(`[discord] Bot connected as ${client!.user?.tag}`);
    setBotClient(client!);
  });

  client.on("messageCreate", (message) => {
    handleMessage(message).catch((err) =>
      console.error("[discord] Message handler error:", err)
    );
  });

  client.on("messageReactionAdd", (reaction, user) => {
    handleReactionAdd(reaction, user).catch((err) =>
      console.error("[discord] Reaction handler error:", err)
    );
  });

  await client.login(config.discordBotToken);
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
