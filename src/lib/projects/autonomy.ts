/**
 * The settings screen's autonomy read model (issue #119). Whether a project can
 * be armed, and how its preflight verdict reads, are pure functions of the row,
 * so the meaning of the control room is table-testable and the components stay
 * dumb renderers — the same seam `buildFleetView` and `organizeTasks` give the
 * dashboard and the archive.
 *
 * The status union is derived from the schema through a *type-only* import,
 * which TypeScript erases: the column enum stays the one source of truth and no
 * drizzle runtime reaches the browser bundle that imports this module.
 */

import type { projects } from "@/db/schema";

type ProjectRow = typeof projects.$inferSelect;

/** Everything arming depends on. Structural rather than the whole row, so both
 * shapes the screen holds — a row from the list route and the one PATCH answers
 * with — can be asked the same questions. */
export interface ProjectAutonomy {
  autonomyEnabled: boolean;
  /** null = preflight has never run for this project. */
  preflightStatus: ProjectRow["preflightStatus"];
  preflightReason: string | null;
}

/**
 * Why the UI refuses to arm this project, or null when nothing stands in the
 * way. Exactly one thing blocks: a preflight that ran and failed. The reducer
 * fails closed on it (`decide.ts` claims nothing for a project whose preflight
 * isn't passing), so arming one would look like work starting and produce
 * none — the owner needs the reason and a deliberate override, not a switch
 * that silently does nothing.
 *
 * A never-checked project is *not* blocked: enabling autonomy runs preflight
 * there and then (`PATCH /api/projects/[id]`, fail-closed), so the unknown
 * resolves into a verdict on the card as a direct result of the arming — on an
 * install with no GitHub App there is nothing to check against, and the project
 * stays unchecked, which is also the honest answer.
 */
export function armBlocker(project: ProjectAutonomy): string | null {
  if (project.preflightStatus !== "failing") return null;
  return project.preflightReason ?? "preflight failed for an unrecorded reason";
}

/** The predicate the arm affordance is gated on: true when the project may be
 * armed from the UI without an explicit override. */
export function canArm(project: ProjectAutonomy): boolean {
  return armBlocker(project) === null;
}

/** Three states, because "failing" and "nobody has looked" are different news
 * and want different tones. */
export type PreflightState = "passing" | "failing" | "unchecked";

export interface PreflightVerdict {
  state: PreflightState;
  /** Fleet tone for the chip: green passing, amber failing, quiet unchecked —
   * a failing preflight is something to fix, not an incident (the dashboard's
   * `needs you` bucket tones it amber for the same reason). */
  tone: "green" | "amber" | "quiet";
  /** The line under the chip: what is missing, or what the state means. Null
   * when passing, where the chip already says everything. */
  detail: string | null;
}

export function preflightVerdict(project: ProjectAutonomy): PreflightVerdict {
  if (project.preflightStatus === "passing") {
    return { state: "passing", tone: "green", detail: null };
  }
  if (project.preflightStatus === "failing") {
    return { state: "failing", tone: "amber", detail: armBlocker(project) };
  }
  return {
    state: "unchecked",
    tone: "quiet",
    detail:
      "Preflight has never run — arming runs it, once the GitHub App is configured.",
  };
}
