import { db } from "@/db";
import { messages, tasks } from "@/db/schema";
import { eq } from "drizzle-orm";
import { newId } from "./ulid";

const MOCK_STEPS = [
  { delay: 500, content: "Starting work on task..." },
  { delay: 1500, content: "Reading project files..." },
  { delay: 2000, content: "Analyzing codebase structure..." },
  { delay: 1000, content: "Planning implementation approach..." },
  { delay: 2500, content: "Writing code changes..." },
  { delay: 1500, content: '→ Modified `src/api/auth.ts`' },
  { delay: 2000, content: "Running tests..." },
  { delay: 1000, content: "All tests passing ✓" },
  { delay: 1500, content: '→ Committed: "feat: implement requested changes"' },
  { delay: 1000, content: "Task complete. Created PR #42." },
];

const MOCK_BLOCKED_STEPS = [
  { delay: 500, content: "Starting work on task..." },
  { delay: 1500, content: "Reading project files..." },
  { delay: 2000, content: "I have a question before proceeding:" },
  {
    delay: 500,
    content:
      "Should I use connection pooling for the database, or is a single connection sufficient for this use case?",
  },
];

export async function runMockAgent(
  taskId: string,
  options: { simulateBlock?: boolean } = {}
): Promise<void> {
  const steps = options.simulateBlock ? MOCK_BLOCKED_STEPS : MOCK_STEPS;

  // Set task to running
  db.update(tasks)
    .set({ status: "running", updatedAt: new Date() })
    .where(eq(tasks.id, taskId))
    .run();

  for (const step of steps) {
    await sleep(step.delay);

    db.insert(messages)
      .values({
        id: newId(),
        taskId,
        role: "agent",
        content: step.content,
        createdAt: new Date(),
      })
      .run();
  }

  // Set final status
  const finalStatus = options.simulateBlock ? "blocked" : "completed";
  db.update(tasks)
    .set({ status: finalStatus, updatedAt: new Date() })
    .where(eq(tasks.id, taskId))
    .run();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
