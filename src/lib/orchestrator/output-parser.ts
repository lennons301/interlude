import { db } from "@/db";
import { messages } from "@/db/schema";
import { newId } from "../ulid";

/**
 * Parse Claude Code stream-json output and insert messages into DB.
 *
 * stream-json format emits NDJSON lines. Key event types:
 * - assistant: text content from Claude
 * - tool_use: tool invocations (file edits, bash commands, etc.)
 * - result: final result with cost info
 * - system: system messages
 */
export function createOutputHandler(taskId: string) {
  let buffer = "";

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

    flush(): void {
      if (buffer.trim()) {
        this.parseLine(buffer.trim());
        buffer = "";
      }
    },

    parseLine(line: string): void {
      try {
        const event = JSON.parse(line);
        const content = extractContent(event);
        if (content) {
          db.insert(messages)
            .values({
              id: newId(),
              taskId,
              role: "agent",
              content,
              createdAt: new Date(),
            })
            .run();
        }
      } catch {
        // Not valid JSON — insert as raw output
        if (line.length > 0) {
          db.insert(messages)
            .values({
              id: newId(),
              taskId,
              role: "system",
              content: line,
              createdAt: new Date(),
            })
            .run();
        }
      }
    },
  };
}

function extractContent(event: Record<string, unknown>): string | null {
  const type = event.type as string | undefined;

  if (type === "assistant" || type === "text") {
    const message = event.message as string | undefined;
    const text = event.text as string | undefined;
    return message ?? text ?? null;
  }

  if (type === "tool_use") {
    const name = (event.name as string) ?? "tool";
    const input = event.input as Record<string, unknown> | undefined;

    if (name === "bash" || name === "Bash") {
      const cmd = input?.command as string;
      return cmd ? `$ ${cmd}` : `→ Running ${name}`;
    }
    if (name === "write" || name === "Write") {
      const filePath = input?.file_path as string;
      return filePath ? `→ Writing ${filePath}` : `→ Writing file`;
    }
    if (name === "edit" || name === "Edit") {
      const filePath = input?.file_path as string;
      return filePath ? `→ Editing ${filePath}` : `→ Editing file`;
    }
    if (name === "read" || name === "Read") {
      const filePath = input?.file_path as string;
      return filePath ? `→ Reading ${filePath}` : `→ Reading file`;
    }

    return `→ Using ${name}`;
  }

  if (type === "tool_result") {
    return null;
  }

  if (type === "result") {
    const cost = event.cost_usd as number | undefined;
    const costStr =
      cost !== undefined ? ` (cost: $${cost.toFixed(4)})` : "";
    return `✓ Agent finished${costStr}`;
  }

  if (type === "error") {
    const message = (event.message as string) ?? "Unknown error";
    return `✗ Error: ${message}`;
  }

  return null;
}
