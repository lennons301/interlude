import { NextResponse } from "next/server";
import { db } from "@/db";
import { SESSION_SKILLS, tasks, type SessionSkill } from "@/db/schema";
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
  const { title, description, projectId, sessionSkill, sessionIssue } = body as {
    title: string;
    description?: string;
    projectId: string;
    // A generation session's skill (issue #61); omitted for a plain chat task.
    sessionSkill?: string;
    // Optional issue anchor (owner/repo#n) passed through to the session.
    sessionIssue?: string;
  };

  if (!title?.trim()) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }
  if (
    sessionSkill !== undefined &&
    !SESSION_SKILLS.includes(sessionSkill as SessionSkill)
  ) {
    return NextResponse.json(
      {
        error: `sessionSkill must be one of: ${SESSION_SKILLS.join(", ")}`,
      },
      { status: 400 }
    );
  }

  const now = new Date();
  // Kind stays `interactive` — a session is a first-class chat task, not a run.
  const task = {
    id: newId(),
    projectId,
    title: title.trim(),
    description: description?.trim() ?? "",
    status: "queued" as const,
    githubIssue: null,
    sessionSkill: (sessionSkill as SessionSkill | undefined) ?? null,
    sessionIssue: sessionIssue?.trim() || null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(tasks).values(task).run();
  return NextResponse.json(task, { status: 201 });
}
