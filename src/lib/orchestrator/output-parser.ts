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

export function createOutputHandler(
  taskId: string,
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
  onQuotaObservation: (observation: QuotaObservation) => void = recordQuotaObservation
) {
  let buffer = "";
  let sessionId: string | null = null;
  let costUsd = 0;
  let finalMessage: string | null = null;
  let subtype: string | null = null;
  let terminalResult: Record<string, unknown> | null = null;
  let rateLimit: QuotaObservation | null = null;
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
      return { sessionId, costUsd, finalMessage, subtype, terminalResult, rateLimit };
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

        db.insert(messages)
          .values({
            id: newId(),
            taskId,
            role: "system",
            type: "system",
            content: JSON.stringify({
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
