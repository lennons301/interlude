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

/** An ordinary chat task is the *absence* of a skill, so it is the one chip no
 * map can key. Named, because both the classifier and the query need it. */
const NO_SKILL_CHIP = "chat" satisfies TaskChip;

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
    return row.sessionSkill === null
      ? NO_SKILL_CHIP
      : SESSION_CHIP[row.sessionSkill];
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
 * What a chip means in column terms, so the route can narrow *before* the row
 * bound (issue #142) and still return exactly the rows `taskChip` would give
 * that chip.
 *
 * Read off `SESSION_CHIP` and `KIND_CHIP` rather than restated, because a second
 * hand-written statement of the same rule is the very thing this module warns
 * about forty lines up — and skills, not chips, are the axis that grows: a new
 * `SessionSkill` must be given a chip in `SESSION_CHIP` to type-check at all,
 * and deriving from it is what makes the new skill filterable in the same
 * stroke instead of silently unreachable.
 */
export function chipColumns(chip: TaskChip): ChipColumns[] {
  const shapes: ChipColumns[] = [];

  const skills = (Object.keys(SESSION_CHIP) as SessionSkill[]).filter(
    (skill) => SESSION_CHIP[skill] === chip
  );
  // The skill-less shape and the skilled ones are both `interactive`, and no
  // chip is ever both, so at most one of these two branches contributes.
  if (chip === NO_SKILL_CHIP) {
    shapes.push({ kind: "interactive", sessionSkills: [null] });
  } else if (skills.length > 0) {
    shapes.push({ kind: "interactive", sessionSkills: skills });
  }

  for (const kind of Object.keys(KIND_CHIP) as (keyof typeof KIND_CHIP)[]) {
    // An unattended pass is named by its kind alone, whatever the skill column
    // happens to hold.
    if (KIND_CHIP[kind] === chip) shapes.push({ kind, sessionSkills: null });
  }

  return shapes;
}

/** The archive's split: a session is the owner at the keyboard — `interactive`
 * and owning no run. Anything a run owns is loop bookkeeping, whatever its
 * kind, so the sessions worth revisiting are never buried under it. */
export function isSession(row: TaskListRow): boolean {
  return row.kind === "interactive" && row.runId === null;
}

/** One filter option: a chip and how many rows carry it. */
export interface ChipCount {
  chip: TaskChip;
  count: number;
}

export interface OrganizedTasks {
  /** Interactive sessions, most recently updated first. */
  interactive: TaskListRow[];
  /** Autonomous passes, most recently updated first. */
  autonomous: TaskListRow[];
  /** Chips present in the *unfiltered* list, in `TASK_CHIPS` order, with their
   * counts — the filter offers only kinds that exist, so no option is dead. */
  chips: ChipCount[];
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

/**
 * What the archive screen is showing, as a value (issue #142). This decision —
 * loading, or failed, or an archive confirmed empty, or a list that may be stale
 * — is what made `/tasks` lie in production: an empty state was rendered over a
 * failed load, so an archive of 222 tasks read as "No tasks yet". The spec rules
 * out component tests, so left inside the component it was verified only by
 * reading it. Out here it is a table.
 *
 * The order of the branches is the argument. A failure with nothing to show is a
 * failure, whether or not an earlier poll happened to answer "empty" — an
 * *unconfirmed* empty archive is the exact lie above, so `empty` is reachable
 * only from a load that succeeded.
 */
export type ListState =
  | { state: "loading" }
  /** Nothing to show, and something broke. */
  | { state: "failed"; error: string }
  /** The archive really is empty — a successful, unfiltered load said so. */
  | { state: "empty" }
  /** Render the list; `stale` is why the last refresh didn't land, if it didn't. */
  | { state: "ready"; stale: string | null };

export function listState(
  rows: readonly TaskListRow[] | null,
  error: string | null,
  /** The filter *these rows were loaded under* — not necessarily the one the
   * screen now shows. A narrowed query answering "nothing" says nothing about
   * the archive being empty, so the empty state stays unreachable from one: the
   * list renders instead, with its filter row intact, and each section says
   * "none of this kind". */
  loadedUnder: TaskFilter = "all"
): ListState {
  if (error !== null && (rows === null || rows.length === 0)) {
    return { state: "failed", error };
  }
  // null = never loaded, which is precisely what a failed first load must not
  // be confused with.
  if (rows === null) return { state: "loading" };
  if (rows.length === 0 && loadedUnder === "all") return { state: "empty" };
  return { state: "ready", stale: error };
}

/**
 * The filter row's options. Now that narrowing happens in SQL (issue #142) the
 * rows on screen are only ever one chip's worth, so the vocabulary can't be read
 * off them: `seen` is the last *unfiltered* load, which is what keeps every
 * other option on offer while one is active — otherwise narrowing to `grill`
 * would leave `grill` as the only way out of `grill`.
 *
 * The active option's count comes from `narrowed` instead, because that is the
 * one number the screen can now state exactly. It can legitimately exceed what
 * `seen` showed: the unfiltered window is bounded by recency, and reaching the
 * rows it cut off is the whole reason the filter moved to the server.
 */
export function filterOptions(
  seen: readonly ChipCount[],
  narrowed: readonly ChipCount[],
  filter: TaskFilter
): ChipCount[] {
  const countIn = (counts: readonly ChipCount[], chip: TaskChip) =>
    counts.find((entry) => entry.chip === chip)?.count ?? 0;

  return TASK_CHIPS.flatMap((chip) => {
    if (chip === filter) return [{ chip, count: countIn(narrowed, chip) }];
    const count = countIn(seen, chip);
    // A chip nothing carries is left off rather than offered as a dead end.
    return count > 0 ? [{ chip, count }] : [];
  });
}
