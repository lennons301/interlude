import { NextResponse } from "next/server";
import { db } from "@/db";
import { SESSION_SKILLS, tasks, type SessionSkill } from "@/db/schema";
import { readLaneCrossing } from "@/lib/lanes/overflow-state";
import { newId } from "@/lib/ulid";
import {
  TASK_CHIPS,
  TASK_LIST_LIMIT,
  type TaskChip,
  type TaskFilter,
} from "@/lib/tasks/organize-tasks";
import { readTaskList } from "@/lib/tasks/task-list-query";

/** The column's own enum, so a status added to the schema is accepted here
 * without a second list to remember. */
const TASK_STATUSES = tasks.status.enumValues;

type TaskStatus = (typeof TASK_STATUSES)[number];

/** The `kind` parameter's vocabulary is the archive's own filter type — a chip,
 * or `all` for no narrowing — so `/tasks` can hand over whatever it holds in
 * state without translating it, and an unknown value is a 400 rather than a
 * silently unfiltered list. */
const KIND_FILTERS: readonly TaskFilter[] = ["all", ...TASK_CHIPS];

/** `limit` raises the archive's default bound, up to MAX_LIMIT, for a
 * deliberate caller. Anything absent, unparseable or non-positive falls back
 * to the default rather than lifting the bound. */
const MAX_LIMIT = 500;

export function parseLimit(raw: string | null): number {
  if (raw === null || raw === "") return TASK_LIST_LIMIT;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return TASK_LIST_LIMIT;
  return Math.min(value, MAX_LIMIT);
}

/**
 * The tasks-list read path (issues #120, #142). The query, the projection it
 * bounds and the chip filter all live in `readTaskList`; what is left here is
 * the part that is genuinely HTTP — reading parameters, refusing the ones that
 * aren't in a published vocabulary, and answering JSON.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  // An empty parameter means "not filtering", as it always has — a caller
  // building `?projectId=${selected ?? ""}` must not be answered with nothing.
  const status = searchParams.get("status") || null;
  const projectId = searchParams.get("projectId") || null;
  const kind = searchParams.get("kind") || null;
  const limit = parseLimit(searchParams.get("limit"));

  if (status !== null && !TASK_STATUSES.includes(status as TaskStatus)) {
    return NextResponse.json(
      { error: `status must be one of: ${TASK_STATUSES.join(", ")}` },
      { status: 400 }
    );
  }
  if (kind !== null && !KIND_FILTERS.includes(kind as TaskFilter)) {
    return NextResponse.json(
      { error: `kind must be one of: ${KIND_FILTERS.join(", ")}` },
      { status: 400 }
    );
  }

  return NextResponse.json(
    readTaskList({
      status: status as TaskStatus | null,
      projectId,
      // `all` is the vocabulary's word for the whole archive, not a chip.
      kind: kind === null || kind === "all" ? null : (kind as TaskChip),
      limit,
    })
  );
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
  // Validated above, so the one narrowing every read below shares.
  const skill = (sessionSkill as SessionSkill | undefined) ?? null;

  // A generation session is refused at entry when no lane can host it (issue
  // #218) — before the row exists, so before a container is anywhere near
  // being provisioned. The judgement is the crossing's, the same one the queue
  // reads before starting a session and the turn manager routes it with, so
  // this route can never accept a session the orchestrator would then hold for
  // that reason. Only that one refusal is answered here, because it is the one
  // that waits on a human changing the fleet: a money hold is a press away and
  // the task screen is where the press lives, and a capable lane that is only
  // walled frees itself at its reset — so a session held for either is still
  // created and held on its feed, exactly as an ordinary chat is.
  if (skill !== null) {
    const crossing = readLaneCrossing("interactive", null, skill);
    if (crossing.refusal?.reason === "no-skill-capable-lane") {
      return NextResponse.json(
        { error: crossing.refusal.message, reason: crossing.refusal.reason },
        { status: 409 }
      );
    }
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
    sessionSkill: skill,
    sessionIssue: sessionIssue?.trim() || null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(tasks).values(task).run();
  return NextResponse.json(task, { status: 201 });
}
