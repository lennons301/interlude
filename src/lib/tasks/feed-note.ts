/**
 * A system line on a task's feed that a repeating caller may write without
 * burying the conversation (issues #172, #173).
 *
 * The two callers are both on loops: a follow-up turn resolves its lane every
 * time the two-second poll finds a queued message, and the queue loop
 * re-checks a held pickup on every cycle. An unfixed misconfiguration or an
 * unanswered confirmation therefore lasts thousands of polls, and a note
 * written each time would be the only thing left on the screen.
 *
 * Comparing against the *latest* message is deliberately all the memory this
 * keeps: anything the owner or the agent says in between makes the same note
 * current news again, which is what you want when someone has just typed
 * "hello?" into a session that is quietly waiting for a press.
 */

import { db } from "@/db";
import { messages } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { newId } from "../ulid";

/** The system-message envelope the chat view reads (`system-note`). */
function envelope(text: string): string {
  return JSON.stringify({ text });
}

/**
 * Write `text` as a system note unless it is already the last thing on this
 * task's feed. Returns whether it was written, so a caller can log exactly
 * once too.
 */
export function noteOnceOnFeed(taskId: string, text: string): boolean {
  const content = envelope(text);
  const latest = db
    .select({ content: messages.content })
    .from(messages)
    .where(eq(messages.taskId, taskId))
    .orderBy(desc(messages.createdAt))
    .limit(1)
    .get();
  if (latest?.content === content) return false;

  db.insert(messages)
    .values({
      id: newId(),
      taskId,
      role: "system",
      type: "system",
      content,
      createdAt: new Date(),
    })
    .run();
  return true;
}
