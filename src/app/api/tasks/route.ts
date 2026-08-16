import { NextResponse } from "next/server";
import { db } from "@/db";
import { projects, SESSION_SKILLS, tasks, type SessionSkill } from "@/db/schema";
import { newId } from "@/lib/ulid";
import { and, desc, eq } from "drizzle-orm";

const TASK_STATUSES = [
  "queued",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;

type TaskStatus = (typeof TASK_STATUSES)[number];

/** The list is an archive, not an export: it is read newest-first and no
 * screen paginates it, so it is bounded here rather than growing with the
 * table forever. `limit` raises it up to MAX_LIMIT for a deliberate caller. */
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(value, MAX_LIMIT);
}

/**
 * The tasks-list read path (issue #120). It projects only the columns a list
 * row renders — deliberately *not* `select().from(tasks)`, which shipped every
 * task's `description` (the full autonomous implement prompt): on prod that was
 * 1035 KB of a 1219 KB response for 44 KB of rendered fields, unbounded and
 * growing with every task. The project name is joined in so a card can name its
 * project without a second round trip per row.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const projectId = searchParams.get("projectId");
  const limit = parseLimit(searchParams.get("limit"));

  if (status !== null && !TASK_STATUSES.includes(status as TaskStatus)) {
    return NextResponse.json(
      { error: `status must be one of: ${TASK_STATUSES.join(", ")}` },
      { status: 400 }
    );
  }

  // One `where`, not two: drizzle's builder replaces the previous predicate
  // rather than anding them, so status + projectId silently dropped the status.
  const filters = [
    status !== null ? eq(tasks.status, status as TaskStatus) : undefined,
    projectId !== null ? eq(tasks.projectId, projectId) : undefined,
  ].filter((f) => f !== undefined);

  const rows = db
    .select({
      id: tasks.id,
      projectId: tasks.projectId,
      projectName: projects.name,
      title: tasks.title,
      status: tasks.status,
      kind: tasks.kind,
      sessionSkill: tasks.sessionSkill,
      runId: tasks.runId,
      costUsd: tasks.totalCostUsd,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .leftJoin(projects, eq(tasks.projectId, projects.id))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(tasks.updatedAt))
    .limit(limit)
    .all();

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
