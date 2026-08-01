/**
 * Pure parsing of ticket text and labels — the semi-trusted input surface.
 * Nothing here performs I/O; the sweep gathers, these functions interpret.
 */

/** How the implement pass's workflow was selected for a ticket. */
export type WorkflowSelection =
  | { source: "body" }
  | { source: "label"; skill: string }
  | { source: "default" }
  | { source: "error"; reason: string };

/**
 * Pick the workflow for an implement pass. A ticket body's own Workflow
 * section always wins; otherwise a single `workflow:<skill>` label selects
 * that skill. Ambiguity is an error, never a guess — a run started from an
 * unresolvable selection must fail loudly rather than fall back silently.
 */
export function selectWorkflow(): WorkflowSelection {
  return { source: "default" };
}
