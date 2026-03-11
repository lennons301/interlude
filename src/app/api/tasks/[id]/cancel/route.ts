import { NextResponse } from "next/server";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { eq } from "drizzle-orm";
import { cancelTask } from "@/lib/orchestrator/task-runner";

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
      { error: `Task is ${task.status}, can only cancel running tasks` },
      { status: 400 }
    );
  }

  await cancelTask(id);
  return NextResponse.json({ cancelled: true });
}
