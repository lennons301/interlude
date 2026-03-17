import { db } from "@/db";
import { messages } from "@/db/schema";
import { eq } from "drizzle-orm";
import { newId } from "../ulid";

/**
 * Parse Claude Code stream-json output and insert messages into DB.
 *
 * stream-json format emits NDJSON lines. Key event types:
 * - assistant: text content from Claude
 * - tool_use: tool invocations (file edits, bash commands, etc.)
 * - tool_result: output from tool invocations (updates preceding tool_use row)
 * - result: final result with cost info
 * - system: system messages
 */

export interface TurnResult {
  sessionId: string | null;
  costUsd: number;
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
        // Assistant text content — message can be a string or array of content blocks
        const raw = event.message;
        let text: string | null = null;

        if (typeof raw === "string") {
          text = raw;
        } else if (Array.isArray(raw)) {
          // Extract text from content blocks: [{type: "text", text: "..."}]
          text = raw
            .filter((b: { type?: string }) => b.type === "text")
            .map((b: { text?: string }) => b.text ?? "")
            .join("");
        }

        if (text) {
          db.insert(messages)
            .values({
              id: newId(),
              taskId,
              role: "agent",
              type: "text",
              content: JSON.stringify({ text }),
              createdAt: new Date(),
            })
            .run();
        }
        return;
      }

      if (type === "tool_use") {
        const name = (event.name as string) ?? "tool";
        const input = event.input as Record<string, unknown> | undefined;
        const msgId = newId();
        lastToolUseMessageId = msgId;

        db.insert(messages)
          .values({
            id: msgId,
            taskId,
            role: "agent",
            type: "tool_use",
            content: JSON.stringify({
              tool: name,
              file_path: (input?.file_path as string) ?? undefined,
              input: input ?? {},
            }),
            createdAt: new Date(),
          })
          .run();
        return;
      }

      if (type === "tool_result") {
        // Update the preceding tool_use message with the output
        if (lastToolUseMessageId) {
          const existing = db
            .select()
            .from(messages)
            .where(eq(messages.id, lastToolUseMessageId))
            .get();

          if (existing) {
            try {
              const parsed = JSON.parse(existing.content);
              const output = (event.content as string) ?? (event.output as string) ?? "";
              parsed.output = typeof output === "string" ? output : JSON.stringify(output);
              db.update(messages)
                .set({ content: JSON.stringify(parsed), updatedAt: new Date() })
                .where(eq(messages.id, lastToolUseMessageId))
                .run();
            } catch {
              // Content not parseable, skip update
            }
          }
        }
        lastToolUseMessageId = null;
        return;
      }

      if (type === "result") {
        sessionId = (event.session_id as string) ?? null;
        // Handle both field names — Claude Code may use either
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

      // Ignore other event types
    },
  };
}
