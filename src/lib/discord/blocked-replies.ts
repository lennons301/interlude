/**
 * A blocked run's answer, collected over REST rather than trusted to the
 * gateway (issue #135, layer 4).
 *
 * `parkBlockedRun` posts the agent's question as an embed and stores its
 * message id on the task. The owner's reply to that embed is the run's next
 * turn — but the only path in was the gateway's `messageCreate`, and on
 * 2026-08-13 a correct reply never arrived: no `messages` row, no reaction,
 * and a run that waited 6.5 hours behind a card indistinguishable from an
 * unanswered one. The estate's own principle applies — the tracker is the
 * coordinator; poll, do not trust delivery — to the one push channel the loop
 * still depended on.
 *
 * Each sweep, for every `blocked` task that carries a question id, this fetches
 * the channel's messages *after* that id and adopts any non-bot reply that
 * *references* it and is not already a row — inserting exactly as the gateway
 * handler does, then reacting 👍. Bounded on purpose: blocked tasks only,
 * messages after the stored question only, replies to the stored id only.
 * Nothing is adopted from general channel chatter, and an already-delivered
 * reply is never delivered twice, because both paths write the Discord message
 * id into the row and check for it before inserting. That closes all three
 * loss modes at once: a dead gateway, a swallowed handler throw, and a reply
 * that arrived while the process was down.
 *
 * `selectRepliesToAdopt` is the decision, pure. `reconcileBlockedReplies` is
 * the thin executor around it — the Discord fetch and the DB insert.
 */

import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { messages, projects, tasks } from "@/db/schema";
import { newId } from "../ulid";
import { getConfig } from "../config";
import { raceWithTimeout, TIMED_OUT } from "../timeout";
import { DISCORD_REST_TIMEOUT_MS, getBotClient } from "./notifications";

/** What matters about a channel message, however the library shaped it. */
export interface ChannelMessageObservation {
  id: string;
  authorIsBot: boolean;
  content: string;
  /** The message this one replies to, or null when it is not a reply. */
  referencedMessageId: string | null;
  createdTimestampMs: number;
}

/** A user message already on the task: what it said, and — for rows written
 * by either Discord path — which Discord message it came from. */
export interface ExistingAnswer {
  discordMessageId: string | null;
  text: string;
}

/**
 * Which of the fetched messages are the owner's replies to the question that
 * have not yet become rows. Oldest first, so two answers land in the order
 * they were given.
 *
 * Idempotency is by Discord message id, with an exact-text fallback for rows
 * written before the id was recorded (a reply the gateway delivered under the
 * previous build, on a run still blocked across the deploy).
 */
export function selectRepliesToAdopt(input: {
  questionMessageId: string;
  channelMessages: ChannelMessageObservation[];
  existingAnswers: ExistingAnswer[];
}): ChannelMessageObservation[] {
  const knownIds = new Set(
    input.existingAnswers
      .map((a) => a.discordMessageId)
      .filter((id): id is string => id != null)
  );
  const knownTexts = new Set(input.existingAnswers.map((a) => a.text.trim()));

  const seen = new Set<string>();
  return input.channelMessages
    .filter((m) => {
      if (m.authorIsBot) return false;
      if (m.referencedMessageId !== input.questionMessageId) return false;
      const text = m.content.trim();
      if (!text) return false;
      if (knownIds.has(m.id) || knownTexts.has(text)) return false;
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    })
    .sort((a, b) => a.createdTimestampMs - b.createdTimestampMs);
}

/**
 * The one way a Discord reply becomes a task's user message — used by the
 * gateway handler and by the REST reconciliation alike, so the two can never
 * disagree about the row's shape. The Discord message id rides in the content
 * JSON beside `text` (no schema change): every reader takes `text` and ignores
 * the rest, and the id is what lets either path see the other's work.
 *
 * Returns false, inserting nothing, when a row for that Discord message is
 * already there — the check and the insert are synchronous with no await
 * between them, so the two paths cannot interleave.
 */
export function insertDiscordAnswer(
  taskId: string,
  text: string,
  discordMessageId: string
): boolean {
  if (existingAnswers(taskId).some((a) => a.discordMessageId === discordMessageId)) {
    return false;
  }
  db.insert(messages)
    .values({
      id: newId(),
      taskId,
      role: "user",
      type: "text",
      content: JSON.stringify({ text: text.trim(), discordMessageId }),
      createdAt: new Date(),
    })
    .run();
  return true;
}

/** The task's user messages, as the selector wants them. */
export function existingAnswers(taskId: string): ExistingAnswer[] {
  return db
    .select({ content: messages.content })
    .from(messages)
    .where(and(eq(messages.taskId, taskId), eq(messages.role, "user")))
    .all()
    .map((row) => parseAnswer(row.content));
}

function parseAnswer(content: string): ExistingAnswer {
  try {
    const parsed = JSON.parse(content) as { text?: unknown; discordMessageId?: unknown };
    return {
      text: typeof parsed.text === "string" ? parsed.text : content,
      discordMessageId:
        typeof parsed.discordMessageId === "string" ? parsed.discordMessageId : null,
    };
  } catch {
    return { text: content, discordMessageId: null };
  }
}

/** What this needs of a fetched message. */
export interface FetchedMessage {
  id: string;
  author: { bot: boolean };
  content: string;
  reference: { messageId?: string | null } | null;
  createdTimestamp: number;
  react(emoji: string): Promise<unknown>;
}

/** The subset of a discord.js channel this needs, so a test can hand in a stub.
 * discord.js returns a `Collection` (a Map keyed by id), so the messages are
 * read through `.values()` — iterating the Collection itself yields entries. */
export interface ReplyChannel {
  messages: {
    fetch(options: { after: string; limit: number }): Promise<{
      values(): IterableIterator<FetchedMessage>;
    }>;
  };
}

export interface ReplyChannelSource {
  fetchChannel(channelId: string): Promise<ReplyChannel | null>;
}

/** How far past the question to look. A blocked run's thread is short; the
 * question embed is the anchor and only replies to it are ever adopted, so the
 * bound only needs to outrun the channel's chatter between question and answer. */
const FETCH_LIMIT = 100;

/**
 * Adopt, over REST, every reply to a blocked run's question the gateway has not
 * delivered. Returns how many were adopted. Never throws — a Discord failure
 * is logged and the sweep goes on; the next sweep tries again.
 */
export async function reconcileBlockedReplies(
  source: ReplyChannelSource | null = botChannelSource()
): Promise<number> {
  if (!source) return 0;

  const parked = db
    .select({
      taskId: tasks.id,
      questionMessageId: tasks.discordMessageId,
      projectChannelId: projects.discordChannelId,
    })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(tasks.status, "blocked"), isNotNull(tasks.discordMessageId)))
    .all();
  if (parked.length === 0) return 0;

  const fleetChannelId = getConfig().discordFleetChannelId;
  let adopted = 0;
  for (const row of parked) {
    // The same resolution parkBlockedRun used to choose where to post.
    const channelId = row.projectChannelId ?? fleetChannelId;
    if (!channelId || !row.questionMessageId) continue;
    try {
      const channel = await source.fetchChannel(channelId);
      if (!channel) continue;
      const fetched = await raceWithTimeout(
        channel.messages.fetch({ after: row.questionMessageId, limit: FETCH_LIMIT }),
        DISCORD_REST_TIMEOUT_MS
      );
      if (fetched === TIMED_OUT) {
        console.warn(
          `[discord] Blocked-reply reconciliation for task ${row.taskId}: channel fetch timed out`
        );
        continue;
      }
      const byId = new Map<string, FetchedMessage>();
      const observations: ChannelMessageObservation[] = [];
      for (const m of fetched.values()) {
        byId.set(m.id, m);
        observations.push({
          id: m.id,
          authorIsBot: m.author.bot,
          content: m.content,
          referencedMessageId: m.reference?.messageId ?? null,
          createdTimestampMs: m.createdTimestamp,
        });
      }
      // Read the rows *after* the fetch, so a reply the gateway delivered while
      // the fetch was in flight is already visible here.
      const toAdopt = selectRepliesToAdopt({
        questionMessageId: row.questionMessageId,
        channelMessages: observations,
        existingAnswers: existingAnswers(row.taskId),
      });
      for (const reply of toAdopt) {
        if (!insertDiscordAnswer(row.taskId, reply.content, reply.id)) continue;
        adopted++;
        console.warn(
          `[discord] Adopted reply ${reply.id} to blocked task ${row.taskId} over REST — ` +
            `the gateway never delivered it`
        );
        // Best-effort, like the gateway path's 👍 — the row is what matters.
        await raceWithTimeout(
          byId.get(reply.id)?.react("👍") ?? Promise.resolve(),
          DISCORD_REST_TIMEOUT_MS
        ).catch((err) =>
          console.error(`[discord] Could not react to adopted reply ${reply.id}:`, err)
        );
      }
    } catch (err) {
      console.error(
        `[discord] Blocked-reply reconciliation failed for task ${row.taskId}:`,
        err
      );
    }
  }
  return adopted;
}

/** The connected bot as a channel source, or null when there is no bot. */
function botChannelSource(): ReplyChannelSource | null {
  const bot = getBotClient();
  if (!bot) return null;
  return {
    async fetchChannel(channelId) {
      const channel = await raceWithTimeout(bot.channels.fetch(channelId), DISCORD_REST_TIMEOUT_MS);
      if (channel === TIMED_OUT || !channel || !channel.isTextBased()) return null;
      return channel as unknown as ReplyChannel;
    },
  };
}
