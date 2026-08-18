/**
 * The tasks-list read model (issue #120). `organizeTasks(rows, filter)` is
 * pure — every input is passed in, nothing is read from the outside — so the
 * session/run split, the kind filter and the chip vocabulary are table-testable
 * and the React components stay dumb renderers. Same contract as the fleet's
 * `buildFleetView`.
 *
 * The status/kind/skill unions are derived from the schema through a *type-only*
 * import, which TypeScript erases: the column enums stay the one source of truth
 * and the `Record` maps below are genuinely exhaustive — a kind or skill added
 * to the schema fails the type check here until it is given a chip — while no
 * drizzle runtime reaches the browser bundle that imports this module.
 */

import type { tasks } from "@/db/schema";
import type { TaskListQueryRow } from "./task-list-query";

type TaskRow = typeof tasks.$inferSelect;

export type TaskStatus = TaskRow["status"];
export type TaskKind = TaskRow["kind"];
export type SessionSkill = NonNullable<TaskRow["sessionSkill"]>;

/** The archive is read newest-first and nothing paginates it, so the read path
 * is bounded rather than growing with the table forever. Shared by the route
 * that applies it and the list that says when it is showing a capped view. */
export const TASK_LIST_LIMIT = 200;

/**
 * One row of the list, *derived* from the projection `GET /api/tasks` selects
 * (issue #142) rather than restated here — two hand-written column lists that
 * have to agree is exactly how a rename type-checks on both sides and ships a
 * card with a blank field. The type-only import keeps the query's drizzle
 * runtime out of the browser bundle that imports this module.
 *
 * `updatedAt` is the one field that legitimately differs from the query: a Date
 * in SQLite, an ISO-8601 string once JSON has carried it here.
 */
export type TaskListRow = Omit<TaskListQueryRow, "updatedAt"> & {
  updatedAt: string;
};

/** The ticket a card names, as the dashboard's running cards do — the run's
 * ticket, or the issue a session was anchored to. Rendered bare (`#34`): the
 * project is already on the card, so the owner/repo prefix is noise. */
export function taskTicket(row: TaskListRow): string | null {
  const ref = row.githubIssue ?? row.sessionIssue;
  if (ref === null) return null;
  const hash = ref.lastIndexOf("#");
  return hash === -1 ? ref : ref.slice(hash);
}

/**
 * The chip vocabulary the owner reads the archive by — what a task *is*, not
 * which column it came from. A generation session is named by its skill (a
 * grilling reads as `grill`, never as the bare `interactive`), which is the
 * same distinction the dashboard's running cards draw.
 */
export const TASK_CHIPS = [
  "chat",
  "grill",
  "spec",
  "tickets",
  "wayfinder",
  "implement",
  "review",
  "repair",
  "triage",
] as const;

export type TaskChip = (typeof TASK_CHIPS)[number];

/** The one kind filter (issue #116 keeps the list restrained: no search, no
 * grouping, no saved views). */
export type TaskFilter = "all" | TaskChip;

const SESSION_CHIP: Record<SessionSkill, TaskChip> = {
  "grill-me": "grill",
  "grill-with-docs": "grill",
  "to-spec": "spec",
  "to-tickets": "tickets",
  triage: "triage",
  wayfinder: "wayfinder",
};

const KIND_CHIP: Record<Exclude<TaskKind, "interactive">, TaskChip> = {
  implement: "implement",
  review: "review",
  triage: "triage",
  repair: "repair",
};

/** A human-driven session's skill and an unattended pass can both be `triage`;
 * they share the chip because they are the same work, and the section they sit
 * in says who drove it. */
export function taskChip(row: TaskListRow): TaskChip {
  if (row.kind === "interactive") {
    return row.sessionSkill === null ? "chat" : SESSION_CHIP[row.sessionSkill];
  }
  return KIND_CHIP[row.kind];
}

/** One `(kind, skill)` shape a chip covers. `sessionSkills: null` means the
 * kind is enough — `taskChip` doesn't read the skill column for an unattended
 * pass — and a `null` *inside* the list means "no skill", which is what makes an
 * ordinary chat task distinguishable from a generation session. */
export interface ChipColumns {
  kind: TaskKind;
  sessionSkills: (SessionSkill | null)[] | null;
}

/**
 * What each chip means in column terms, so the route can narrow *before* the
 * row bound (issue #142) and still return exactly the rows `taskChip` would
 * give that chip. Two entries are the interesting ones: `chat` is the absence of
 * a skill, and `triage` is genuinely two shapes — an unattended pass and a
 * human-driven session — because it is one kind of work whichever drove it.
 *
 * This is a second statement of `taskChip`, which is a real risk, so the route's
 * tests (`src/app/api/__tests__/task-list-filter.test.ts`) run the generated SQL
 * against every `(kind, skill)` pair the schema allows and compare it with
 * `taskChip` row by row, rather than trusting the reading. `Record<TaskChip, …>` keeps it exhaustive: a chip
 * added to the vocabulary fails the type check here until it can be queried.
 */
export const CHIP_COLUMNS: Record<TaskChip, ChipColumns[]> = {
  chat: [{ kind: "interactive", sessionSkills: [null] }],
  grill: [
    { kind: "interactive", sessionSkills: ["grill-me", "grill-with-docs"] },
  ],
  spec: [{ kind: "interactive", sessionSkills: ["to-spec"] }],
  tickets: [{ kind: "interactive", sessionSkills: ["to-tickets"] }],
  wayfinder: [{ kind: "interactive", sessionSkills: ["wayfinder"] }],
  implement: [{ kind: "implement", sessionSkills: null }],
  review: [{ kind: "review", sessionSkills: null }],
  repair: [{ kind: "repair", sessionSkills: null }],
  triage: [
    { kind: "interactive", sessionSkills: ["triage"] },
    { kind: "triage", sessionSkills: null },
  ],
};

/** The archive's split: a session is the owner at the keyboard — `interactive`
 * and owning no run. Anything a run owns is loop bookkeeping, whatever its
 * kind, so the sessions worth revisiting are never buried under it. */
export function isSession(row: TaskListRow): boolean {
  return row.kind === "interactive" && row.runId === null;
}

export interface OrganizedTasks {
  /** Interactive sessions, most recently updated first. */
  interactive: TaskListRow[];
  /** Autonomous passes, most recently updated first. */
  autonomous: TaskListRow[];
  /** Chips present in the *unfiltered* list, in `TASK_CHIPS` order, with their
   * counts — the filter offers only kinds that exist, so no option is dead. */
  chips: { chip: TaskChip; count: number }[];
  /** Rows before the filter, so the UI can say "3 of 40". */
  total: number;
}

export function organizeTasks(
  rows: readonly TaskListRow[],
  filter: TaskFilter
): OrganizedTasks {
  const counts = new Map<TaskChip, number>();
  for (const row of rows) {
    const chip = taskChip(row);
    counts.set(chip, (counts.get(chip) ?? 0) + 1);
  }

  const kept =
    filter === "all"
      ? rows.slice()
      : rows.filter((row) => taskChip(row) === filter);
  // The list owns its own order rather than trusting the query's: newest
  // activity first, in both sections.
  kept.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  return {
    interactive: kept.filter(isSession),
    autonomous: kept.filter((row) => !isSession(row)),
    chips: TASK_CHIPS.flatMap((chip) => {
      const count = counts.get(chip) ?? 0;
      return count > 0 ? [{ chip, count }] : [];
    }),
    total: rows.length,
  };
}
