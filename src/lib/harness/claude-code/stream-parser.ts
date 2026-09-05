import { db } from "@/db";
import { messages } from "@/db/schema";
import { eq } from "drizzle-orm";
import { newId } from "../../ulid";
import {
  getStreamRecorder,
  type StreamRecorder,
} from "../../orchestrator/stream-recorder";
import {
  parseRateLimitEvent,
  type QuotaObservation,
} from "../../quota/rate-limit-event";
import { recordQuotaObservation } from "../../quota/quota-store";
import type { TurnTokenUsage } from "../../lanes/lane-cost";
import type { TurnResult } from "../turn-result";
import { classifyClaudeExit, readFinalMessage } from "./outcome";

/**
 * Parse Claude Code stream-json output and insert messages into DB.
 *
 * The Claude Code adapter's own stream parser (issue #214): it lived in the
 * orchestrator as `output-parser.ts` until this ticket moved it under the
 * adapter, because it is the member of the seam most likely to be mistaken for
 * orchestrator code and the one a second harness most certainly replaces. The
 * orchestrator sees only the `TurnResult` it hands back, whose `outcome` is
 * the fleet's vocabulary (`./outcome.ts`) and never this stream's.
 *
 * Claude Code `--output-format stream-json --verbose` emits NDJSON with these top-level types:
 * - system: init events, hook events (ignored)
 * - assistant: contains message.content[] with blocks: text, tool_use, thinking
 * - user: contains message.content[] with tool_result blocks
 * - result: final result with session_id, total_cost_usd
 * - rate_limit_event: quota state, confirmed to reach stdout (issue #165) —
 *   read into the turn result and recorded as the fleet's quota state (#167).
 *   Pausing (#168) and admission (#171) decide on it downstream
 *
 * Anything else, and any line that is not JSON at all, is handed to the passive
 * recorder rather than dropped silently (issue #165). Nothing about how a
 * recognised event parses changed: the recorder is a side-channel, and a stream
 * that carries no unrecognised event produces exactly the messages it did
 * before.
 */

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

/** A token count, or null when the field was not reported at all.
 *
 * Absent is kept apart from zero for the same reason `utilization` is over in
 * the quota reader: a lane charges from these numbers, and a report whose
 * fields are all missing must not price as a free turn. Negatives are treated
 * as unreported — a count cannot be one. */
function readCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/** One reader's four counts, before they are known to be worth anything. */
type PartialCounts = Record<keyof TurnTokenUsage, number | null>;

const EMPTY_COUNTS: PartialCounts = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
};

const COUNT_KEYS = Object.keys(EMPTY_COUNTS) as (keyof TurnTokenUsage)[];

/**
 * The turn's token counts, summed over every model it used (issue #175).
 *
 * **`modelUsage` and nothing else.** The sibling `usage` object looks like a
 * cheap fallback and is a trap: the captured turns show it carrying the *last
 * API iteration* rather than the turn (`usage.input_tokens: 10` beside
 * `modelUsage.inputTokens: 909`), and only `modelUsage` reproduces the CLI's
 * own cost at list prices. Charging a lane's prices against `usage` would
 * therefore undercharge by ~90x with every appearance of being right — the one
 * direction `chargeForTurn` refuses to fail in. A harness that reports no
 * `modelUsage` gets null here and is charged its own reported figure instead,
 * which over-states on a third-party lane and is the safe half of that trade.
 *
 * Summed across entries rather than read from one, because a pass that spawns
 * subagents bills several models under one turn and the lane charges for all of
 * them. Null unless at least one count was actually a number: a shape carrying
 * the field names and no values would otherwise total to a legitimate-looking
 * zero. A genuine zero survives, since zero is reported as a number.
 */
export function readTurnUsage(
  event: Record<string, unknown>
): TurnTokenUsage | null {
  const modelUsage = event.modelUsage;
  if (modelUsage === null || typeof modelUsage !== "object") return null;

  const totals = Object.values(modelUsage as Record<string, unknown>)
    .filter(
      (entry): entry is Record<string, unknown> =>
        entry !== null && typeof entry === "object"
    )
    .reduce<PartialCounts>(
      (total, entry) =>
        addCounts(total, {
          inputTokens: readCount(entry.inputTokens),
          outputTokens: readCount(entry.outputTokens),
          cacheReadTokens: readCount(entry.cacheReadInputTokens),
          cacheWriteTokens: readCount(entry.cacheCreationInputTokens),
        }),
      EMPTY_COUNTS
    );

  if (COUNT_KEYS.every((key) => totals[key] === null)) return null;
  return {
    inputTokens: totals.inputTokens ?? 0,
    outputTokens: totals.outputTokens ?? 0,
    cacheReadTokens: totals.cacheReadTokens ?? 0,
    cacheWriteTokens: totals.cacheWriteTokens ?? 0,
  };
}

/** Add two partial reports, keeping "neither reported this" as unreported. */
function addCounts(a: PartialCounts, b: PartialCounts): PartialCounts {
  const sum = { ...EMPTY_COUNTS };
  for (const key of COUNT_KEYS) {
    sum[key] =
      a[key] === null && b[key] === null ? null : (a[key] ?? 0) + (b[key] ?? 0);
  }
  return sum;
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
        // Classified here, at the end, rather than as the result event arrives:
        // a quota wall is only legible from the terminal event and the last
        // rate-limit event together, and the latter may land after the former.
        outcome: classifyClaudeExit(terminalResult, rateLimit),
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
        terminalResult = event;
        // The one rule for the final message (`./outcome.ts`): the CLI's own
        // `result` string when it states one, else the last text block above.
        finalMessage = readFinalMessage(event, finalMessage);
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
