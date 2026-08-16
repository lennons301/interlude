/**
 * The tasks-list read model (issue #120). `organizeTasks(rows, filter)` is
 * pure — every input is passed in, nothing is read from the outside — so the
 * session/run split, the kind filter and the chip vocabulary are table-testable
 * and the React components stay dumb renderers. Same contract as the fleet's
 * `buildFleetView`, and the same deliberate decoupling: the row and enum types
 * are restated here rather than imported from `@/db/schema`, so importing this
 * module from a client component never drags drizzle into the browser bundle.
 * The DB column enums remain the runtime source of truth; the `Record` maps
 * below are exhaustive, so a kind or skill added there fails the type check
 * here until it is given a chip.
 */

export type TaskStatus =
  | "queued"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskKind =
  | "interactive"
  | "implement"
  | "review"
  | "triage"
  | "repair";

export type SessionSkill =
  | "grill-me"
  | "grill-with-docs"
  | "triage"
  | "to-spec"
  | "to-tickets"
  | "wayfinder";

/** One row of the list, exactly as `GET /api/tasks` projects it — deliberately
 * not the whole task: the list never renders `description` (the full implement
 * prompt), and shipping it made the archive a megabyte of dead weight. */
export interface TaskListRow {
  id: string;
  projectId: string;
  /** Null only if the project row went missing; the card renders a dash. */
  projectName: string | null;
  title: string;
  status: TaskStatus;
  kind: TaskKind;
  sessionSkill: SessionSkill | null;
  runId: string | null;
  costUsd: number;
  /** ISO-8601, as JSON carries it. */
  updatedAt: string;
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
