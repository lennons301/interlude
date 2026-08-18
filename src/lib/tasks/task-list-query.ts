/**
 * The tasks-list query (issues #120, #142). It lives here rather than inline in
 * `GET /api/tasks` for two reasons.
 *
 * The projection is the source of the row type the client renders: `TaskListRow`
 * is *derived* from this query's result, so renaming a column here is a type
 * error at every card that reads it instead of a blank field in production. The
 * key-set assertion the route's tests carry catches an added or dropped column;
 * a rename type-checked on both sides and shipped broken.
 *
 * And the kind filter belongs in the `where`, not in the client. The archive is
 * bounded to the most recent rows, so a filter applied after the bound can only
 * narrow the window — on a box whose loop mints implement/review rows far faster
 * than a human opens sessions, the sessions worth revisiting had already fallen
 * out of it. Narrowing in SQL reaches past the bound.
 */

import { and, desc, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { projects, tasks } from "@/db/schema";
import { chipColumns, TASK_LIST_LIMIT, type TaskChip } from "./organize-tasks";

/** The column enums, from the schema this module already talks to rather than
 * from the read model the browser reads — the query is the lower layer. */
type TaskStatus = (typeof tasks.status.enumValues)[number];

/** Only the columns a list row renders — deliberately not `select().from(tasks)`,
 * which shipped every task's `description` (the full autonomous implement
 * prompt): on prod that was 1035 KB of a 1219 KB response for 44 KB of rendered
 * fields, unbounded and growing with every task. The project name is joined in
 * so a card can name its project without a round trip per row. */
const TASK_LIST_COLUMNS = {
  id: tasks.id,
  projectId: tasks.projectId,
  projectName: projects.name,
  title: tasks.title,
  status: tasks.status,
  kind: tasks.kind,
  sessionSkill: tasks.sessionSkill,
  runId: tasks.runId,
  githubIssue: tasks.githubIssue,
  sessionIssue: tasks.sessionIssue,
  costUsd: tasks.totalCostUsd,
  updatedAt: tasks.updatedAt,
};

export interface TaskListFilters {
  status?: TaskStatus | null;
  projectId?: string | null;
  /** A chip from the archive's own vocabulary, or null for the whole archive. */
  kind?: TaskChip | null;
  limit?: number;
}

/**
 * `chip` in column terms. Every chip is a disjunction of `(kind, skill)` shapes
 * because `taskChip` reads both columns: a grilling session is `interactive`
 * plus a skill, and `triage` is both an unattended pass and a human-driven
 * session. `chipColumns` derives those shapes from the same maps `taskChip`
 * classifies with, and this route's tests compare the generated SQL with
 * `taskChip` over every row the schema allows — that agreement is the whole
 * safety argument for filtering in SQL.
 */
function chipFilter(chip: TaskChip): SQL {
  const alternatives = chipColumns(chip).map(({ kind, sessionSkills }) => {
    const isKind = eq(tasks.kind, kind);
    // null = the kind is enough; taskChip ignores the skill column for it.
    if (sessionSkills === null) return isKind;
    const named = sessionSkills.filter((skill) => skill !== null);
    return and(
      isKind,
      or(
        named.length > 0 ? inArray(tasks.sessionSkill, named) : undefined,
        sessionSkills.includes(null) ? isNull(tasks.sessionSkill) : undefined
      )
    );
  });
  // Non-empty by construction: every chip is in the image of `SESSION_CHIP` or
  // `KIND_CHIP`, which `chipColumns` derives its shapes from.
  return or(...alternatives) as SQL;
}

export function readTaskList({
  status = null,
  projectId = null,
  kind = null,
  limit = TASK_LIST_LIMIT,
}: TaskListFilters = {}) {
  // One `where`, not several: drizzle's builder replaces the previous predicate
  // rather than anding them, so status + projectId silently dropped the status.
  const filters = [
    status !== null ? eq(tasks.status, status) : undefined,
    projectId !== null ? eq(tasks.projectId, projectId) : undefined,
    kind !== null ? chipFilter(kind) : undefined,
  ].filter((filter) => filter !== undefined);

  return db
    .select(TASK_LIST_COLUMNS)
    .from(tasks)
    .leftJoin(projects, eq(tasks.projectId, projects.id))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(tasks.updatedAt))
    .limit(limit)
    .all();
}

/** One row as the query returns it, server-side: `updatedAt` is still a Date. */
export type TaskListQueryRow = ReturnType<typeof readTaskList>[number];
