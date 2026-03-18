import { db } from "@/db";
import { messages } from "@/db/schema";
import { eq } from "drizzle-orm";
import { newId } from "../ulid";

/**
 * Parse Claude Code stream-json output and insert messages into DB.
 *
 * Claude Code `--output-format stream-json --verbose` emits NDJSON with these top-level types:
 * - system: init events, hook events (ignored)
 * - assistant: contains message.content[] with blocks: text, tool_use, thinking
 * - user: contains message.content[] with tool_result blocks
 * - result: final result with session_id, total_cost_usd
 * - rate_limit_event: rate limiting info (ignored)
 */

export interface TurnResult {
  sessionId: string | null;
  costUsd: number;
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

export function createOutputHandler(taskId: string) {
  let buffer = "";
  let sessionId: string | null = null;
  let costUsd = 0;
  let lastToolUseMessageId: string | null = null;

  return {
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
      return { sessionId, costUsd };
    },

    parseLine(line: string): void {
      try {
        const event = JSON.parse(line);
        this.handleEvent(event);
      } catch {
        // Not valid JSON — insert as raw system message
        if (line.length > 0) {
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

      if (type === "assistant") {
        // message is an object: { content: [{ type: "text"|"tool_use"|"thinking", ... }] }
        const msg = event.message as Record<string, unknown> | undefined;
        if (!msg) return;
        const contentBlocks = (msg.content ?? []) as ContentBlock[];
        if (!Array.isArray(contentBlocks)) return;

        for (const block of contentBlocks) {
          if (block.type === "text" && block.text) {
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

      // Ignore system (hooks/init), rate_limit_event, and other event types
    },
  };
}
