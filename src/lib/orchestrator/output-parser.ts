import { db } from "@/db";
import { messages } from "@/db/schema";
import { eq } from "drizzle-orm";
import { newId } from "../ulid";
import { getStreamRecorder, type StreamRecorder } from "./stream-recorder";
import {
  parseRateLimitEvent,
  type QuotaObservation,
} from "../quota/rate-limit-event";
import { recordQuotaObservation } from "../quota/quota-store";
import type { TurnTokenUsage } from "../lanes/lane-cost";

/**
 * Parse Claude Code stream-json output and insert messages into DB.
 *
 * Claude Code `--output-format stream-json --verbose` emits NDJSON with these top-level types:
 * - system: init events, hook events (ignored)
 * - assistant: contains message.content[] with blocks: text, tool_use, thinking
 * - user: contains message.content[] with tool_result blocks
 * - result: final result with session_id, total_cost_usd
 * - rate_limit_event: quota state, confirmed to reach stdout (issue #165) —
 *   read into the turn result and recorded as the fleet's quota state (#167).
 *   Nothing *decides* on it yet: pausing (#168) and admission (#171) do that
 *
 * Anything else, and any line that is not JSON at all, is handed to the passive
 * recorder rather than dropped silently (issue #165). Nothing about how a
 * recognised event parses changed: the recorder is a side-channel, and a stream
 * that carries no unrecognised event produces exactly the messages it did
 * before.
 */

export interface TurnResult {
  sessionId: string | null;
  costUsd: number;
  /** The turn's last assistant text message — what the blocked-marker
   * detector reads. Null when the turn produced no text at all. */
  finalMessage: string | null;
  /** The result event's subtype ("success", "error_max_turns", ...) — how
   * turn exhaustion is detected. Null when no result event arrived. */
  subtype: string | null;
  /**
   * The terminal `result` event verbatim, or null when none arrived (issue
   * #165) — what the passive recorder writes down as the pass's exit
   * condition.
   *
   * Carried whole rather than as picked fields because `subtype` above is not
   * enough to classify an exit and the spike found the specific way it is not:
   * a rate-limit rejection arrives as `subtype: "success"` with `is_error:
   * true`, `terminal_reason: "api_error"` and `api_error_status: 429`. Nothing
   * reads those yet — #167 and #168 will — so the log keeps the whole event
   * instead of a summary chosen before anyone knew which fields mattered.
   */
  terminalResult: Record<string, unknown> | null;
  /**
   * The last `rate_limit_event` of the turn, read into an observation (issue
   * #167), or null when the stream carried none — which is the ordinary case
   * on a metered lane, where the unified-window machinery emits nothing at all.
   *
   * The last, not the first: the CLI emits one per API attempt, so a turn that
   * retried carries several and only the newest describes the account now.
   */
  rateLimit: QuotaObservation | null;
  /**
   * The tokens the turn consumed, or null when no `result` event arrived
   * (issue #175) — what a lane's own prices are applied to when the harness's
   * dollar figure cannot be trusted.
   *
   * Read from `modelUsage` rather than from the sibling `usage` object,
   * because `modelUsage` is the aggregate the CLI itself charges from. Pinned
   * by observation on 2026-09-02: a subscription turn reported
   * `usage.input_tokens: 10` beside `modelUsage.inputTokens: 909`, and only
   * the latter reproduces the CLI's own `total_cost_usd` at list prices to the
   * cent. `usage` is the last API iteration; `modelUsage` is the turn.
   */
  usage: TurnTokenUsage | null;
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
}

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/**
 * The turn's token counts, summed over every model it used (issue #175).
 *
 * Summed rather than read from one entry because a pass that spawns subagents
 * bills several models under one turn, and a lane charges for all of them. The
 * sibling `usage` object is the fallback for a harness that reports no
 * `modelUsage` at all; null when neither is present, which `chargeForTurn`
 * has its own (deliberately over-reporting) answer for.
 */
export function readTurnUsage(
  event: Record<string, unknown>
): TurnTokenUsage | null {
  const modelUsage = event.modelUsage;
  if (modelUsage !== null && typeof modelUsage === "object") {
    const entries = Object.values(modelUsage as Record<string, unknown>).filter(
      (entry): entry is Record<string, unknown> =>
        entry !== null && typeof entry === "object"
    );
    if (entries.length > 0) {
      return entries.reduce<TurnTokenUsage>(
        (total, entry) => ({
          inputTokens: total.inputTokens + readCount(entry.inputTokens),
          outputTokens: total.outputTokens + readCount(entry.outputTokens),
          cacheReadTokens:
            total.cacheReadTokens + readCount(entry.cacheReadInputTokens),
          cacheWriteTokens:
            total.cacheWriteTokens + readCount(entry.cacheCreationInputTokens),
        }),
        { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
      );
    }
  }

  const usage = event.usage;
  if (usage === null || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  return {
    inputTokens: readCount(u.input_tokens),
    outputTokens: readCount(u.output_tokens),
    cacheReadTokens: readCount(u.cache_read_input_tokens),
    cacheWriteTokens: readCount(u.cache_creation_input_tokens),
  };
}

export function createOutputHandler(
  taskId: string,
  /**
   * The lane this turn runs on (issue #175) — which quota state an observed
   * `rate_limit_event` belongs to.
   *
   * Required rather than defaulted, because the whole point is that there is
   * no fleet-wide quota to fall back to: a rate limit is a fact about one
   * account on one provider, and attributing a subscription observation to a
   * metered lane (or the reverse) is how a lane that *cannot* report quota ends
   * up gated by somebody else's wall.
   */
  laneId: string,
  /** Injectable so the recorder can be observed in tests without a filesystem;
   * production always takes the process-wide one. */
  recorder: StreamRecorder = getStreamRecorder(),
  /**
   * Where an observed quota state is persisted (issue #167). Written here, at
   * the moment of observation, rather than by the caller once the turn settles:
   * an interactive turn can run for an hour, and a tile reporting the quota as
   * it was when the turn *started* would be the fleet's freshest fact arriving
   * last. Injectable for the same reason the recorder is.
   */
  onQuotaObservation: (observation: QuotaObservation) => void = (observation) =>
    recordQuotaObservation(laneId, observation)
) {
  let buffer = "";
  let sessionId: string | null = null;
  let costUsd = 0;
  let finalMessage: string | null = null;
  let subtype: string | null = null;
  let terminalResult: Record<string, unknown> | null = null;
  let rateLimit: QuotaObservation | null = null;
  let usage: TurnTokenUsage | null = null;
  let lastToolUseMessageId: string | null = null;
  let _onDone: (() => void) | null = null;

  return {
    /** Register a callback fired when the "result" event arrives (turn complete). */
    onDone(cb: () => void) { _onDone = cb; },

    write(chunk: Buffer | string): void {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.parseLine(trimmed);
      }
    },

    flush(): TurnResult {
      if (buffer.trim()) {
        this.parseLine(buffer.trim());
        buffer = "";
      }
      return {
        sessionId,
        costUsd,
        finalMessage,
        subtype,
        terminalResult,
        rateLimit,
        usage,
      };
    },

    parseLine(line: string): void {
      try {
        const event = JSON.parse(line);
        this.handleEvent(event);
      } catch {
        // Not valid JSON — insert as raw system message
        if (line.length > 0) {
          recorder.unparseableLine(taskId, line);
          db.insert(messages)
            .values({
              id: newId(),
              taskId,
              role: "agent",
              type: "system",
              content: JSON.stringify({ text: line }),
              createdAt: new Date(),
            })
            .run();
        }
      }
    },

    handleEvent(event: Record<string, unknown>): void {
      const type = event.type as string | undefined;

      // Before the type switch, not in its default arm: the recorder's own
      // allowlist decides what is worth keeping, so it stays the single
      // statement of "which event types do we claim to understand" rather than
      // that being implied by the shape of the branches below (issue #165).
      recorder.streamEvent(taskId, event);

      if (type === "assistant") {
        // message is an object: { content: [{ type: "text"|"tool_use"|"thinking", ... }] }
        const msg = event.message as Record<string, unknown> | undefined;
        if (!msg) return;
        const contentBlocks = (msg.content ?? []) as ContentBlock[];
        if (!Array.isArray(contentBlocks)) return;

        for (const block of contentBlocks) {
          if (block.type === "text" && block.text) {
            finalMessage = block.text;
            db.insert(messages)
              .values({
                id: newId(),
                taskId,
                role: "agent",
                type: "text",
                content: JSON.stringify({ text: block.text }),
                createdAt: new Date(),
              })
              .run();
          } else if (block.type === "tool_use") {
            const msgId = newId();
            lastToolUseMessageId = msgId;
            const input = block.input ?? {};

            db.insert(messages)
              .values({
                id: msgId,
                taskId,
                role: "agent",
                type: "tool_use",
                content: JSON.stringify({
                  tool: block.name ?? "tool",
                  file_path: (input.file_path as string) ?? undefined,
                  input,
                }),
                createdAt: new Date(),
              })
              .run();
          }
          // Ignore "thinking" blocks — internal reasoning
        }
        return;
      }

      if (type === "user") {
        // user events contain tool_result blocks
        const msg = event.message as Record<string, unknown> | undefined;
        if (!msg) return;
        const contentBlocks = (msg.content ?? []) as ContentBlock[];
        if (!Array.isArray(contentBlocks)) return;

        for (const block of contentBlocks) {
          if (block.type === "tool_result" && lastToolUseMessageId) {
            const existing = db
              .select()
              .from(messages)
              .where(eq(messages.id, lastToolUseMessageId))
              .get();

            if (existing) {
              try {
                const parsed = JSON.parse(existing.content);
                // tool_result content can be a string or array of content parts
                let output = "";
                if (typeof block.content === "string") {
                  output = block.content;
                } else if (Array.isArray(block.content)) {
                  output = block.content
                    .filter((p) => p.type === "text")
                    .map((p) => p.text ?? "")
                    .join("");
                }
                parsed.output = output;
                db.update(messages)
                  .set({ content: JSON.stringify(parsed), updatedAt: new Date() })
                  .where(eq(messages.id, lastToolUseMessageId))
                  .run();
              } catch {
                // Content not parseable, skip update
              }
            }
            lastToolUseMessageId = null;
          }
        }
        return;
      }

      if (type === "result") {
        sessionId = (event.session_id as string) ?? null;
        subtype = (event.subtype as string) ?? null;
        terminalResult = event;
        costUsd =
          (event.total_cost_usd as number) ??
          (event.cost_usd as number) ??
          0;
        usage = readTurnUsage(event);

        db.insert(messages)
          .values({
            id: newId(),
            taskId,
            role: "system",
            type: "system",
            content: JSON.stringify({
              // The harness's own figure, which on a lane that declares prices
              // is not what the turn is charged (issue #175) — `runTurn` adds
              // the lane's number beside this line when the two differ, rather
              // than this one quietly reporting a price nobody paid.
              text: `Turn complete (cost: $${costUsd.toFixed(4)})`,
            }),
            createdAt: new Date(),
          })
          .run();
        if (_onDone) _onDone();
        return;
      }

      if (type === "rate_limit_event") {
        // Latest wins, within a turn as across the fleet: the account has one
        // quota, and the newest event is the only one describing it now.
        const observed = parseRateLimitEvent(event, new Date());
        if (observed) {
          rateLimit = observed;
          onQuotaObservation(observed);
        }
        return;
      }

      if (type === "error") {
        const message = (event.message as string) ?? "Unknown error";
        db.insert(messages)
          .values({
            id: newId(),
            taskId,
            role: "system",
            type: "system",
            content: JSON.stringify({ text: `Error: ${message}` }),
            createdAt: new Date(),
          })
          .run();
        return;
      }

      // Ignore system (hooks/init) and every other event type here — anything
      // this parser does not act on has already been handed to the recorder
      // above, so "ignored" no longer means "lost" (issue #165).
    },
  };
}
