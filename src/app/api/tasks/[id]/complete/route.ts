import { NextResponse } from "next/server";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { eq } from "drizzle-orm";
import { completeTask, getActiveTasks } from "@/lib/orchestrator/task-runner";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!task) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (task.status !== "running") {
    return NextResponse.json(
      { error: `Task is ${task.status}, can only complete running tasks` },
      { status: 400 }
    );
  }

  // Check active tasks state for debugging
  const active = getActiveTasks();
  const entry = active.get(id);
  console.log(`[complete] task=${id} activeTasks.size=${active.size} entry=${entry ? entry.state : "NOT_FOUND"}`);

  if (!entry) {
    return NextResponse.json({
      error: "Task has no active container (server may have restarted)",
      activeTasks: active.size
    }, { status: 409 });
  }

  // Fire-and-forget — completeTask handles the async lifecycle
  completeTask(id).catch(console.error);
  return NextResponse.json({ completing: true });
}
