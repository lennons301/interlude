import { db } from "@/db";
import { messages, tasks } from "@/db/schema";
import { and, eq, gt, asc } from "drizzle-orm";
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

    const poll = setInterval(() => {
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

      // Send task status updates
      const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
      if (task) {
        const cs = task.containerStatus ?? null;
        const ts = task.status;
        if (cs !== lastContainerStatus || ts !== lastTaskStatus) {
          lastContainerStatus = cs;
          lastTaskStatus = ts;
          send(
            {
              containerStatus: cs,
              status: ts,
              totalCostUsd: task.totalCostUsd ?? 0,
            },
            "taskStatus"
          );
        }
      }
    }, 500);

    return () => clearInterval(poll);
  });
}
