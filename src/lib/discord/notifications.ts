import { Client, EmbedBuilder, TextChannel, type Message } from "discord.js";
import { DIGEST_TITLE_PREFIX, type DigestContent } from "../fleet/digest";
import { raceWithTimeout, TIMED_OUT } from "../timeout";
import {
  formatDuration,
  type OwedReviewStall,
  type PickupWedge,
  type QueueStale,
} from "../fleet/health";

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
 * Wall-clock ceiling on one Discord REST operation (issue #151). Best-effort
 * notifications still have to *settle*: the idle and blocked embeds are awaited
 * inside the promise that holds a queue reservation, so one that never came back
 * is one more way to wedge dispatch — the same discipline the Docker admission
 * probe got in #128.
 *
 * A ceiling is needed because nothing above @discordjs/rest's own 15s
 * per-attempt abort is bounded: it retries that attempt, sleeps out a 429's
 * `Retry-After`, and `sendWithRetry` retries again on top. It is generous enough
 * that a healthy send has finished several times over, and no larger, because
 * the trade-off below gets worse the longer we wait.
 */
export const DISCORD_REST_TIMEOUT_MS = 30_000;

/**
 * A REST call abandoned at the ceiling, distinct from a call that failed. The
 * distinction matters: the abandoned attempt may yet be delivered by the library
 * underneath us, so this is the one failure we must not retry — a retry is how
 * one notification becomes two embeds.
 */
class DiscordRestTimeout extends Error {}

/**
 * Bound one Discord REST call. Fails closed when the bound is reached — every
 * caller here either logs and moves on (the notify* helpers) or owns a retry
 * (the digest scheduler), and both are better served by a failure than by
 * waiting forever.
 */
async function bounded<T>(what: string, call: Promise<T>): Promise<T> {
  const result = await raceWithTimeout(call, DISCORD_REST_TIMEOUT_MS);
  if (result === TIMED_OUT) {
    throw new DiscordRestTimeout(
      `Discord ${what} did not answer within ${DISCORD_REST_TIMEOUT_MS}ms`
    );
  }
  return result;
}

/**
 * Send an embed with a few retries + backoff, so a transient network blip
 * (e.g. flaky connection) doesn't silently drop a notification. Throws if all
 * attempts fail — callers already wrap sends in try/catch (fire-and-forget).
 *
 * Each attempt is bounded, and reaching that bound ends the whole send rather
 * than starting another attempt (issue #151): an attempt abandoned at the
 * ceiling may still be delivered by the library underneath us, so retrying it
 * risks two embeds where one was meant. A dropped notification is the better
 * failure — the dashboard carries everything Discord pushes.
 */
async function sendWithRetry(
  channel: TextChannel,
  embed: EmbedBuilder,
  attempts = 3
): Promise<Message> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await bounded("send", channel.send({ embeds: [embed] }));
    } catch (err) {
      lastErr = err;
      if (err instanceof DiscordRestTimeout) break;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      }
    }
  }
  throw lastErr;
}

/** Resolve a channel to post in, or throw. The fire-and-forget notify* helpers
 * call this inside their own try/catch and swallow the failure; the digest
 * scheduler lets it through and retries. Bounded, like every REST call here. */
async function fetchTextChannel(channelId: string): Promise<TextChannel> {
  const botClient = getBotClient();
  if (!botClient) throw new Error("Discord bot not connected");
  const channel = await bounded(
    `channel ${channelId} lookup`,
    botClient.channels.fetch(channelId)
  );
  if (!channel || !channel.isTextBased()) {
    throw new Error(`Channel ${channelId} is not a text channel`);
  }
  return channel as TextChannel;
}

/**
 * Post the daily digest to the fleet channel. Throws on failure — the
 * digest scheduler owns the retry, because a silently dropped digest would
 * defeat "one message each morning".
 */
export async function postDailyDigest(
  channelId: string,
  content: DigestContent
): Promise<void> {
  const channel = await fetchTextChannel(channelId);

  const embed = new EmbedBuilder()
    .setTitle(content.title)
    .setColor(0x7b61ff)
    .addFields(
      content.sections.map((section) => {
        const value = section.lines.join("\n");
        return {
          name: section.heading,
          // Backstop for Discord's 1024-char field limit — the renderer's
          // per-section line cap should keep us well under it
          value: value.length <= 1024 ? value : `${value.slice(0, 1023)}…`,
        };
      })
    );

  await sendWithRetry(channel, embed);
}

/**
 * Has this bot already posted a digest to the channel since `since`?
 * Keys on the digest's stable title prefix, so a tick after a redeploy is
 * idempotent. Throws when Discord can't be asked — the scheduler retries
 * rather than guessing.
 */
export async function hasDigestPostedSince(
  channelId: string,
  since: Date
): Promise<boolean> {
  const channel = await fetchTextChannel(channelId);

  const recent = await bounded(
    `message history of channel ${channelId}`,
    channel.messages.fetch({ limit: 100 })
  );
  return recent.some(
    (msg) =>
      msg.author.id === channel.client.user?.id &&
      msg.createdTimestamp >= since.getTime() &&
      msg.embeds.some((e) => e.title?.startsWith(DIGEST_TITLE_PREFIX))
  );
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
    const channel = await fetchTextChannel(channelId);

    const domain = process.env.DOMAIN ?? "interludes.co.uk";
    const embed = new EmbedBuilder()
      .setTitle(`Task queued: ${task.title}`)
      .setDescription(`Project: ${task.projectName}`)
      .setURL(`https://${domain}/tasks/${task.id}`)
      .setColor(0x7b61ff);

    const msg = await sendWithRetry(channel, embed);
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
    const channel = await fetchTextChannel(channelId);

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

    await sendWithRetry(channel, embed);
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
    const channel = await fetchTextChannel(channelId);

    const domain = process.env.DOMAIN ?? "interludes.co.uk";
    const embed = new EmbedBuilder()
      .setTitle(`Task failed: ${task.title}`)
      .setDescription(`Error: ${task.error}`)
      .setURL(`https://${domain}/tasks/${task.id}`)
      .setColor(0xef4444);

    await sendWithRetry(channel, embed);
  } catch (err) {
    console.error(`[discord] Failed to send failed notification:`, err);
  }
}

/**
 * Announce slot saturation to the fleet channel — sent once per transition
 * (the autonomy sweep tracks the transition; this just delivers). No-op when
 * no fleet channel is configured: the sweep already logged it.
 */
export async function notifySlotsSaturated(
  channelId: string | null,
  payload: { occupied: number; total: number; occupants: string[] }
): Promise<void> {
  const botClient = getBotClient();
  if (!botClient || !channelId) return;

  try {
    const channel = await fetchTextChannel(channelId);

    const embed = new EmbedBuilder()
      .setTitle(`All ${payload.total} agent slot(s) busy`)
      .setDescription(
        payload.occupants.length
          ? payload.occupants.map((o) => `• ${o}`).join("\n")
          : "New work waits for a free slot."
      )
      .setColor(0xf59e0b);

    await sendWithRetry(channel, embed);
  } catch (err) {
    console.error(`[discord] Failed to send saturation notification:`, err);
  }
}

/**
 * Fleet-health watchdog (issue #126): a run's review pass has not started for
 * too long — the PR sits owed a review while the slot is busy. Sent once per
 * stall (the sweep tracks the announcement; this just delivers). No-op when no
 * fleet channel is configured: the sweep already logged it.
 */
export async function notifyOwedReviewStalled(
  channelId: string | null,
  payload: OwedReviewStall
): Promise<void> {
  const botClient = getBotClient();
  if (!botClient || !channelId) return;

  try {
    const channel = await fetchTextChannel(channelId);

    const embed = new EmbedBuilder()
      .setTitle(`Owed review stalled — PR #${payload.prNumber}`)
      .setDescription(
        `${payload.issueRef} (PR #${payload.prNumber}) has been owed a review for ` +
          `~${formatDuration(payload.stalledForMs)} without it starting: ${payload.reason}.\n\n` +
          `Nothing merges until the review lands — free a slot or check the queue.`
      )
      .setColor(0xef4444);

    await sendWithRetry(channel, embed);
  } catch (err) {
    console.error(`[discord] Failed to send owed-review-stalled notification:`, err);
  }
}

/**
 * Fleet-health watchdog (issue #126): pickup is wedged — a slot is free but
 * claimable work is not dispatching. Sent once per wedge. No-op when no fleet
 * channel is configured: the sweep already logged it.
 */
export async function notifyPickupWedged(
  channelId: string | null,
  payload: PickupWedge
): Promise<void> {
  const botClient = getBotClient();
  if (!botClient || !channelId) return;

  try {
    const channel = await fetchTextChannel(channelId);

    const embed = new EmbedBuilder()
      .setTitle(`Pickup wedged — claimable work is not dispatching`)
      // The remedy comes from the evaluator, not from here, so the ping and the
      // dashboard card can never advise differently (issue #152: a phantom slot
      // needs a restart, an ordinary wedge needs a look).
      .setDescription(
        `${payload.detail} for ~${formatDuration(payload.wedgedForMs)}. ${payload.remedy}`
      )
      .setColor(0xef4444);

    await sendWithRetry(channel, embed);
  } catch (err) {
    console.error(`[discord] Failed to send pickup-wedged notification:`, err);
  }
}

/**
 * Fleet-health watchdog (issue #126): the queue poll loop, which should tick
 * every 2s, has stopped making progress. Sent once per stall. No-op when no
 * fleet channel is configured: the sweep already logged it.
 */
export async function notifyQueueStale(
  channelId: string | null,
  payload: QueueStale
): Promise<void> {
  const botClient = getBotClient();
  if (!botClient || !channelId) return;

  try {
    const channel = await fetchTextChannel(channelId);

    const embed = new EmbedBuilder()
      .setTitle(`Queue loop stalled`)
      .setDescription(
        `The queue poll loop hasn't made progress for ~${formatDuration(payload.staleForMs)} ` +
          `(it should tick every 2s). Dispatch is likely wedged — check the ` +
          `orchestrator process.`
      )
      .setColor(0xef4444);

    await sendWithRetry(channel, embed);
  } catch (err) {
    console.error(`[discord] Failed to send queue-stale notification:`, err);
  }
}

/**
 * Tell the owner gate evaluation failed closed for a PR — the gate config
 * was missing or unparseable, so nothing was armed. Sent once per failure
 * (the autonomy sweep tracks the announcement; this just delivers). No-op
 * when no fleet channel is configured: the sweep already logged it.
 */
export async function notifyGateConfigError(
  channelId: string | null,
  payload: { issueRef: string; prNumber: number; reason: string }
): Promise<void> {
  const botClient = getBotClient();
  if (!botClient || !channelId) return;

  try {
    const channel = await fetchTextChannel(channelId);

    const embed = new EmbedBuilder()
      .setTitle(`Gate config error — nothing armed`)
      .setDescription(
        `${payload.issueRef} (PR #${payload.prNumber}) finished its implement pass, ` +
          `but the review-gate config could not be read: ${payload.reason}\n\n` +
          `The PR stays disarmed until the config on the default branch is fixed.`
      )
      .setColor(0xef4444);

    await sendWithRetry(channel, embed);
  } catch (err) {
    console.error(`[discord] Failed to send gate-config-error notification:`, err);
  }
}

/**
 * Post a blocked run's question — to the project's linked channel, or the
 * fleet channel when the project has none. Returns the Discord message ID so
 * it becomes the task's current interactive message: replying to it queues
 * the answer as the agent's next turn.
 */
export async function notifyRunBlocked(
  channelId: string,
  task: {
    id: string;
    title: string;
    question: string;
    issueRef: string | null;
    projectName: string | null;
  }
): Promise<string | null> {
  const botClient = getBotClient();
  if (!botClient) return null;

  try {
    const channel = await fetchTextChannel(channelId);

    const domain = process.env.DOMAIN ?? "interludes.co.uk";
    const lines = [task.question.trim().slice(0, 1000), ""];
    if (task.projectName) lines.push(`Project: ${task.projectName}`);
    if (task.issueRef) lines.push(`Ticket: ${task.issueRef}`);
    lines.push("", "Reply to answer — your reply becomes the agent's next turn.");

    const embed = new EmbedBuilder()
      .setTitle(`Agent blocked: ${task.title}`)
      .setDescription(lines.join("\n"))
      .setURL(`https://${domain}/tasks/${task.id}`)
      .setColor(0xf59e0b);

    const msg = await sendWithRetry(channel, embed);
    return msg.id;
  } catch (err) {
    console.error(`[discord] Failed to send blocked notification:`, err);
    return null;
  }
}

/**
 * Tell the owner a review verdict could not be acted on — the pass's output
 * was unparseable, or the review could not be posted. Nothing merges until a
 * human looks. Sent once per failure (the autonomy sweep tracks the
 * announcement; this just delivers). No-op when no fleet channel is
 * configured: the sweep already logged it.
 */
export async function notifyReviewBlocked(
  channelId: string | null,
  payload: { issueRef: string; prNumber: number; reason: string }
): Promise<void> {
  const botClient = getBotClient();
  if (!botClient || !channelId) return;

  try {
    const channel = await fetchTextChannel(channelId);

    const embed = new EmbedBuilder()
      .setTitle(`Review blocked — nothing merged`)
      .setDescription(
        `${payload.issueRef} (PR #${payload.prNumber}): ${payload.reason}\n\n` +
          `The PR stays disarmed until you look.`
      )
      .setColor(0xef4444);

    await sendWithRetry(channel, embed);
  } catch (err) {
    console.error(`[discord] Failed to send review-blocked notification:`, err);
  }
}

/**
 * A parked PR still conflicts with the default branch after its automated
 * integration repairs are spent (issue #54): a human must resolve the conflict
 * and merge. Pushed once per stall — the dashboard's conflict needs-you entry
 * carries it after that.
 */
export async function notifyIntegrationEscalation(
  channelId: string | null,
  payload: { issueRef: string; prNumber: number; integrationsMade: number }
): Promise<void> {
  const botClient = getBotClient();
  if (!botClient || !channelId) return;

  try {
    const channel = await fetchTextChannel(channelId);

    const repairs = `${payload.integrationsMade} automated repair${
      payload.integrationsMade === 1 ? "" : "s"
    }`;
    const embed = new EmbedBuilder()
      .setTitle(`Merge conflict needs you — nothing merged`)
      .setDescription(
        `${payload.issueRef} (PR #${payload.prNumber}) still conflicts with the ` +
          `default branch after ${repairs}.\n\n` +
          `Auto-merge is disarmed — resolve the conflict and merge.`
      )
      .setColor(0xef4444);

    await sendWithRetry(channel, embed);
  } catch (err) {
    console.error(`[discord] Failed to send integration-escalation notification:`, err);
  }
}

/**
 * A reviewed PR whose head moved past the commit its verdict was written about,
 * with no review cycle left to spend on re-reviewing it (issue #131): a human
 * owns the merge decision now. Pushed at the moment the loop stops, because
 * nothing else will happen on this PR until someone looks — the alternative is
 * a reviewed-looking PR quietly sitting on an unreviewed head.
 */
export async function notifyStaleReviewEscalation(
  channelId: string | null,
  payload: {
    issueRef: string;
    prNumber: number;
    /** Short SHA the review was written about */
    reviewedHeadSha: string;
    /** Short SHA the PR carries now */
    headSha: string;
    /** Why the loop stopped re-reviewing */
    detail: string;
    /** Whether the stale review was actually withdrawn — it may still be
     * standing (GitHub refused, or the account lacks the right on a protected
     * branch), and an operator about to merge needs to know which */
    reviewWithdrawn: boolean;
  }
): Promise<void> {
  const botClient = getBotClient();
  if (!botClient || !channelId) return;

  try {
    const channel = await fetchTextChannel(channelId);

    const embed = new EmbedBuilder()
      .setTitle(`Reviewed commit moved — nothing merged`)
      .setDescription(
        `${payload.issueRef} (PR #${payload.prNumber}) was reviewed at ` +
          `\`${payload.reviewedHeadSha}\` and its head is now \`${payload.headSha}\` — ` +
          `${payload.detail}.\n\n` +
          `Auto-merge is disarmed and ` +
          (payload.reviewWithdrawn
            ? `the stale review is withdrawn`
            : `**the stale review is still standing** — read the issue for why`) +
          ` — review the current head and merge.`
      )
      .setColor(0xef4444);

    await sendWithRetry(channel, embed);
  } catch (err) {
    console.error(`[discord] Failed to send stale-review notification:`, err);
  }
}

/**
 * A parked PR whose checks are still failing after its automated CI repairs are
 * spent (issue #130): a human must make the branch green. Pushed once per stall,
 * like the conflict escalation above — after that the dashboard's failing-checks
 * needs-you card carries it. Red CI is never left visible only on GitHub.
 */
export async function notifyChecksEscalation(
  channelId: string | null,
  payload: {
    issueRef: string;
    prNumber: number;
    ciRepairsMade: number;
    /** Names of the checks still failing */
    failedChecks: string[];
  }
): Promise<void> {
  const botClient = getBotClient();
  if (!botClient || !channelId) return;

  try {
    const channel = await fetchTextChannel(channelId);

    const repairs =
      payload.ciRepairsMade === 1
        ? "an automated repair"
        : `${payload.ciRepairsMade} automated repairs`;
    const embed = new EmbedBuilder()
      .setTitle(`Failing checks need you — nothing merged`)
      .setDescription(
        `${payload.issueRef} (PR #${payload.prNumber}) still fails its checks ` +
          `after ${repairs}: ${payload.failedChecks.join(", ")}.\n\n` +
          `Auto-merge is disarmed — make the branch green and merge.`
      )
      .setColor(0xef4444);

    await sendWithRetry(channel, embed);
  } catch (err) {
    console.error(`[discord] Failed to send checks-escalation notification:`, err);
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
    const channel = await fetchTextChannel(channelId);

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

    const msg = await sendWithRetry(channel, embed);
    return msg.id;
  } catch (err) {
    console.error(`[discord] Failed to send idle notification:`, err);
    return null;
  }
}

/**
 * Post a triage recommendation: the pass judged a new issue well specified,
 * and arming is one explicit yes away. Returns the Discord message ID so it
 * becomes the triage task's interactive message — a reply of "yes" is the
 * confirmation the orchestrator arms on. Anything else, including silence,
 * leaves the issue un-armed.
 */
export async function notifyTriageRecommendation(
  channelId: string,
  rec: {
    taskId: string;
    issueRef: string;
    issueTitle: string;
    assessment: string;
    projectName: string | null;
  }
): Promise<string | null> {
  const botClient = getBotClient();
  if (!botClient) return null;

  try {
    const channel = await fetchTextChannel(channelId);

    const domain = process.env.DOMAIN ?? "interludes.co.uk";
    const lines = [rec.assessment.trim().slice(0, 800), ""];
    if (rec.projectName) lines.push(`Project: ${rec.projectName}`);
    lines.push(`Ticket: ${rec.issueRef}`);
    lines.push(
      "",
      "Reply **yes** to arm it (applies `ready-for-agent`), or apply the " +
        "label on GitHub yourself. Anything else leaves it un-armed."
    );

    const embed = new EmbedBuilder()
      .setTitle(`Triage recommends arming: ${rec.issueTitle}`)
      .setDescription(lines.join("\n"))
      .setURL(`https://${domain}/tasks/${rec.taskId}`)
      .setColor(0xf59e0b);

    const msg = await sendWithRetry(channel, embed);
    return msg.id;
  } catch (err) {
    console.error(`[discord] Failed to send triage recommendation:`, err);
    return null;
  }
}

/**
 * Tell the owner a ticket burnt its last attempt and went back to a human —
 * `ready-for-agent` swapped for `ready-for-human`. Sent to the project's
 * linked channel, or the fleet channel when the project has none. No-op when
 * neither is configured: the sweep already logged and commented on the issue.
 */
export async function notifyAttemptsExhausted(
  channelId: string | null,
  payload: {
    issueRef: string;
    attempts: number;
    interruptions: number;
    /** Quota resumes spent, for the `quota-pauses` reason (issue #169) */
    resumes?: number;
    reason: "attempts" | "interruptions" | "quota-pauses";
    totalSpendUsd: number;
  }
): Promise<void> {
  const botClient = getBotClient();
  if (!botClient || !channelId) return;

  try {
    const channel = await fetchTextChannel(channelId);

    const embed = new EmbedBuilder().setColor(0xef4444);
    if (payload.reason === "interruptions") {
      embed
        .setTitle(`Interruption bound hit — ${payload.issueRef} needs you`)
        .setDescription(
          `${payload.interruptions} runs lost to interruptions — restarts or ` +
            `containers that died before finishing ` +
            `($${payload.totalSpendUsd.toFixed(2)} autonomous spend). Re-claims are ` +
            `bounded, so the ticket is now \`ready-for-human\`; the story is on the issue.`
        );
    } else if (payload.reason === "quota-pauses") {
      // Deliberately says what was *not* spent: this is the one exhaustion
      // whose ticket still has its attempts, so "re-arm it later" is the
      // obvious next move rather than a judgement call about the work.
      embed
        .setTitle(`Quota pauses spent — ${payload.issueRef} needs you`)
        .setDescription(
          `Attempt ${payload.attempts} kept being refused by the account's quota ` +
            `(${payload.resumes ?? 0} resumes spent, ` +
            `$${payload.totalSpendUsd.toFixed(2)} autonomous spend). The ticket is ` +
            `now \`ready-for-human\` — but a quota pause spends no attempt, so ` +
            `re-arming it once there is quota picks the work up where it stopped.`
        );
    } else {
      embed
        .setTitle(`Attempts exhausted — ${payload.issueRef} needs you`)
        .setDescription(
          `All ${payload.attempts} attempts failed ` +
            `($${payload.totalSpendUsd.toFixed(2)} autonomous spend). ` +
            `The ticket is now \`ready-for-human\`; the per-attempt story is on the issue.`
        );
    }

    await sendWithRetry(channel, embed);
  } catch (err) {
    console.error(`[discord] Failed to send attempts-exhausted notification:`, err);
  }
}

/**
 * Announce (once per day — the sweep tracks the flag) that the daily
 * autonomous spend cap paused pickup. Interactive work is unaffected and the
 * pause lifts at local midnight. No-op when no fleet channel is configured.
 */
export async function notifyDailyCapReached(
  channelId: string | null,
  payload: { spentUsd: number; capUsd: number }
): Promise<void> {
  const botClient = getBotClient();
  if (!botClient || !channelId) return;

  try {
    const channel = await fetchTextChannel(channelId);

    const embed = new EmbedBuilder()
      .setTitle(`Daily autonomous spend cap reached`)
      .setDescription(
        `$${payload.spentUsd.toFixed(2)} of the $${payload.capUsd.toFixed(2)} daily cap ` +
          `is spent — autonomous pickup is paused until local midnight. ` +
          `Interactive tasks are unaffected.`
      )
      .setColor(0xef4444);

    await sendWithRetry(channel, embed);
  } catch (err) {
    console.error(`[discord] Failed to send daily-cap notification:`, err);
  }
}
