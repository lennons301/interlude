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
