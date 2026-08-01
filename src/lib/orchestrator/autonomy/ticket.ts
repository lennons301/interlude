/**
 * Pure parsing of ticket text and labels — the semi-trusted input surface.
 * Nothing here performs I/O; the sweep gathers, these functions interpret.
 */

export const ARMING_LABEL = "ready-for-agent";
export const INTERACTIVE_TRIGGER_LABEL = "interlude";

const WORKFLOW_LABEL_PREFIX = "workflow:";

/** A `## Workflow` (or `### Workflow`) section heading in a ticket body. */
const WORKFLOW_SECTION = /^#{2,3}\s+Workflow\s*$/im;

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
export function selectWorkflow(body: string, labels: string[]): WorkflowSelection {
  if (WORKFLOW_SECTION.test(body)) return { source: "body" };

  const workflowLabels = labels.filter((l) => l.startsWith(WORKFLOW_LABEL_PREFIX));
  if (workflowLabels.length === 0) return { source: "default" };
  if (workflowLabels.length > 1) {
    return {
      source: "error",
      reason: `multiple workflow labels: ${workflowLabels.join(", ")}`,
    };
  }

  const skill = workflowLabels[0].slice(WORKFLOW_LABEL_PREFIX.length).trim();
  if (!skill) {
    return { source: "error", reason: `workflow label names no skill: "${workflowLabels[0]}"` };
  }
  return { source: "label", skill };
}

/**
 * Issue numbers named by `Blocked by: #n[, #m]` lines — the estate's fallback
 * convention where native issue dependencies aren't available. Only a line
 * (optionally bulleted) that starts with "Blocked by:" counts; prose mentions
 * do not.
 */
export function parseBlockedByRefs(body: string): number[] {
  const refs = new Set<number>();
  for (const line of body.split("\n")) {
    const match = line.match(/^\s*(?:[-*]\s*)?blocked by:(.*)$/i);
    if (!match) continue;
    for (const ref of match[1].matchAll(/#(\d+)/g)) {
      refs.add(parseInt(ref[1], 10));
    }
  }
  return [...refs];
}

/**
 * Whether an `interlude`-labelled issue should become an interactive task.
 * When `ready-for-agent` is also present it wins: the issue belongs to the
 * autonomy loop and no duplicate interactive task is created.
 */
export function shouldCreateInteractiveTask(labels: string[]): boolean {
  return !labels.includes(ARMING_LABEL);
}

/** GitHub delivers labels as strings or `{ name }` objects depending on the
 * surface (webhook payload vs REST); normalize to plain names. */
export function labelNames(
  labels: Array<string | { name?: string | null }> | null | undefined
): string[] {
  return (labels ?? [])
    .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
    .filter(Boolean);
}
