import { db } from "@/db";
import { messages } from "@/db/schema";
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

    const poll = setInterval(() => {
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
    }, 500);

    return () => clearInterval(poll);
  });
}
