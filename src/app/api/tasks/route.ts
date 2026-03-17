import { NextResponse } from "next/server";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { newId } from "@/lib/ulid";
import { desc, eq } from "drizzle-orm";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const projectId = searchParams.get("projectId");

  let query = db.select().from(tasks).orderBy(desc(tasks.updatedAt)).$dynamic();

  if (status) {
    query = query.where(eq(tasks.status, status as "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled"));
  }
  if (projectId) {
    query = query.where(eq(tasks.projectId, projectId));
  }

  const rows = await query;
  return NextResponse.json(rows);
}

export async function POST(request: Request) {
  const body = await request.json();
  const { title, description, projectId } = body as {
    title: string;
    description?: string;
    projectId: string;
  };

  if (!title?.trim()) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }

  const now = new Date();
  const task = {
    id: newId(),
    projectId,
    title: title.trim(),
    description: description?.trim() ?? "",
    status: "queued" as const,
    githubIssue: null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(tasks).values(task).run();
  return NextResponse.json(task, { status: 201 });
}
