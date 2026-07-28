import { Client, EmbedBuilder, TextChannel } from "discord.js";

// The bot client is set once, in the instrumentation/orchestrator context where
// the Discord bot connects (client.ts -> setBotClient). But notification helpers
// are also called from App-Router route handlers (e.g. POST /api/tasks/[id]/complete),
// which Next.js may load as a SEPARATE module instance. A module-level `let` would
// be null in that instance, silently no-op'ing the notification. Backing it with
// globalThis shares the single connected client across all module instances.
const globalForBot = globalThis as unknown as { __interludeBotClient?: Client | null };

/** Called by client.ts once the bot is ready */
export function setBotClient(client: Client): void {
  globalForBot.__interludeBotClient = client;
}

export function getBotClient(): Client | null {
  return globalForBot.__interludeBotClient ?? null;
}

/**
 * Post a "task queued" notification. Returns the Discord message ID
 * so it can be stored on the task for reply mapping.
 */
export async function notifyTaskQueued(
  channelId: string,
  task: { id: string; title: string; projectName: string }
): Promise<string | null> {
  const botClient = getBotClient();
  if (!botClient) return null;

  try {
    const channel = await botClient.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return null;

    const domain = process.env.DOMAIN ?? "interludes.co.uk";
    const embed = new EmbedBuilder()
      .setTitle(`Task queued: ${task.title}`)
      .setDescription(`Project: ${task.projectName}`)
      .setURL(`https://${domain}/tasks/${task.id}`)
      .setColor(0x7b61ff);

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
  const botClient = getBotClient();
  if (!botClient) return;

  try {
    const channel = await botClient.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return;

    const domain = process.env.DOMAIN ?? "interludes.co.uk";
    const cost = task.totalCostUsd.toFixed(2);

    const embed = new EmbedBuilder()
      .setTitle(`Task complete: ${task.title}`)
      .setURL(`https://${domain}/tasks/${task.id}`)
      .setColor(0x22c55e);

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
  const botClient = getBotClient();
  if (!botClient) return;

  try {
    const channel = await botClient.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return;

    const domain = process.env.DOMAIN ?? "interludes.co.uk";
    const embed = new EmbedBuilder()
      .setTitle(`Task failed: ${task.title}`)
      .setDescription(`Error: ${task.error}`)
      .setURL(`https://${domain}/tasks/${task.id}`)
      .setColor(0xef4444);

    await (channel as TextChannel).send({ embeds: [embed] });
  } catch (err) {
    console.error(`[discord] Failed to send failed notification:`, err);
  }
}

/**
 * Post an "agent finished a turn — your move" idle notification.
 * Returns the Discord message ID so it can become the task's current
 * interactive message (for ✅-to-complete and reply-to-continue).
 */
export async function notifyTaskIdle(
  channelId: string,
  task: { id: string; title: string; summary: string; branch: string }
): Promise<string | null> {
  const botClient = getBotClient();
  if (!botClient) return null;

  try {
    const channel = await botClient.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return null;

    const domain = process.env.DOMAIN ?? "interludes.co.uk";
    const summary = task.summary.trim()
      ? task.summary.trim().slice(0, 500)
      : "(no summary)";

    const embed = new EmbedBuilder()
      .setTitle(`Agent finished a turn: ${task.title}`)
      .setDescription(
        `${summary}\n\nBranch: \`${task.branch}\`\n\nReact ✅ to complete · reply to continue`
      )
      .setURL(`https://${domain}/tasks/${task.id}`)
      .setColor(0xf59e0b);

    const msg = await (channel as TextChannel).send({ embeds: [embed] });
    return msg.id;
  } catch (err) {
    console.error(`[discord] Failed to send idle notification:`, err);
    return null;
  }
}
