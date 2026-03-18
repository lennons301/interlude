import { db } from "@/db";
import { messages, tasks } from "@/db/schema";
import { and, eq, gt, lte, asc, isNotNull } from "drizzle-orm";
import { createSSEStream } from "@/lib/sse";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const after = searchParams.get("after");

  return createSSEStream(request.signal, (send) => {
    let lastSeen = after ?? "";
    let lastContainerStatus: string | null = null;
    let lastTaskStatus: string | null = null;
    let lastDevPort: number | null = null;
    let lastPollTime = new Date();

    const poll = setInterval(() => {
      const pollStart = new Date();

      // Send new messages
      const where = lastSeen
        ? and(eq(messages.taskId, id), gt(messages.id, lastSeen))
        : eq(messages.taskId, id);

      const newMessages = db
        .select()
        .from(messages)
        .where(where)
        .orderBy(asc(messages.createdAt))
        .all();

      for (const msg of newMessages) {
        send(msg, "message");
        lastSeen = msg.id;
      }

      // Send updates to already-seen messages (e.g. tool_use rows updated with tool_result output)
      if (lastSeen) {
        const updatedMessages = db
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.taskId, id),
              lte(messages.id, lastSeen),
              isNotNull(messages.updatedAt),
              gt(messages.updatedAt, lastPollTime)
            )
          )
          .orderBy(asc(messages.createdAt))
          .all();

        for (const msg of updatedMessages) {
          send(msg, "message");
        }
      }

      lastPollTime = pollStart;

      // Send task status updates
      const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
      if (task) {
        const cs = task.containerStatus ?? null;
        const ts = task.status;
        const dp = task.devPort ?? null;
        if (cs !== lastContainerStatus || ts !== lastTaskStatus || dp !== lastDevPort) {
          lastContainerStatus = cs;
          lastTaskStatus = ts;
          lastDevPort = dp;
          send(
            {
              containerStatus: cs,
              status: ts,
              totalCostUsd: task.totalCostUsd ?? 0,
              devPort: dp,
            },
            "taskStatus"
          );
        }
      }
    }, 500);

    return () => clearInterval(poll);
  });
}
