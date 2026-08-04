/**
 * Pure parsing of ticket text and labels — the semi-trusted input surface.
 * Nothing here performs I/O; the sweep gathers, these functions interpret.
 */

import {
  ALLOWED_TICKET_EFFORTS,
  MAX_ATTEMPT_BUDGET_USD,
  MAX_TURNS_CEILING,
} from "./budgets";

export const ARMING_LABEL = "ready-for-agent";
export const READY_FOR_HUMAN_LABEL = "ready-for-human";
export const NEEDS_TRIAGE_LABEL = "needs-triage";
export const NEEDS_INFO_LABEL = "needs-info";
export const WONTFIX_LABEL = "wontfix";
export const INTERACTIVE_TRIGGER_LABEL = "interlude";

/** The five canonical triage-role labels (docs/agents/triage-labels.md). An
 * issue carrying any of these has already been routed — a new issue arriving
 * with one is not re-marked for triage. */
export const TRIAGE_ROLE_LABELS = [
  NEEDS_TRIAGE_LABEL,
  NEEDS_INFO_LABEL,
  ARMING_LABEL,
  READY_FOR_HUMAN_LABEL,
  WONTFIX_LABEL,
];

/** The only labels a triage exit may apply — advisory routing, never arming.
 * The reducer's exit mapping draws from this set alone, and the executor
 * refuses an applyTriage action carrying anything else. `ready-for-agent`
 * is excluded by construction: triage reads semi-trusted input, so its
 * ceiling is enforced in trusted code, not requested in a prompt. */
export const ADVISORY_TRIAGE_LABELS = [NEEDS_INFO_LABEL, READY_FOR_HUMAN_LABEL];

const WORKFLOW_LABEL_PREFIX = "workflow:";

/** A `## Workflow` (or `### Workflow`) section heading in a ticket body. */
const WORKFLOW_SECTION = /^#{2,3}\s+Workflow\s*$/im;

/** A whole-line `key: value` directive (optionally bulleted, case-insensitive). */
const DIRECTIVE_LINE = /^\s*(?:[-*]\s+)?([a-z-]+)\s*:\s*(.*)$/i;

/**
 * The bounded directive set a ticket may carry in its Workflow section.
 * Null means "not specified — use the default". Directives can only move
 * bounded numbers or add human oversight; there is deliberately no key that
 * touches gates, the reviewer, auto-merge or the daily cap, and unknown keys
 * are ignored rather than interpreted.
 */
export interface TicketDirectives {
  /** Per-attempt budget in USD, clamped to MAX_ATTEMPT_BUDGET_USD */
  budget: number | null;
  /** Per-exec turn limit, clamped to MAX_TURNS_CEILING */
  maxTurns: number | null;
  /** Checkpoint text — forces supervised mode (issue #20 wires this) */
  checkpoint: string | null;
  /** Named workflow — informational in v1 (selectWorkflow drives the pass) */
  workflow: string | null;
  /** Reasoning-effort level to run the pass at (issue #81), clamped to
   * ALLOWED_TICKET_EFFORTS. Null means unspecified or unrecognised — the run
   * keeps its default effort; a bad value never fails the run. */
  effort: string | null;
}

/**
 * Parse the bounded directive set from a ticket body. Only whole lines inside
 * the ticket's Workflow section count — directive-shaped text in prose or
 * inside code fences is data, not instructions, and issue bodies are
 * semi-trusted input that must never widen its own authority.
 */
export function parseTicketDirectives(body: string): TicketDirectives {
  const directives: TicketDirectives = {
    budget: null,
    maxTurns: null,
    checkpoint: null,
    workflow: null,
    effort: null,
  };

  for (const line of workflowSectionLines(body)) {
    const match = line.match(DIRECTIVE_LINE);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();

    if (key === "budget" && directives.budget === null) {
      const amount = value.match(/^\$?(\d+(?:\.\d+)?)$/);
      const parsed = amount ? parseFloat(amount[1]) : NaN;
      if (parsed > 0) directives.budget = Math.min(parsed, MAX_ATTEMPT_BUDGET_USD);
    } else if (key === "max-turns" && directives.maxTurns === null) {
      const parsed = /^\d+$/.test(value) ? parseInt(value, 10) : NaN;
      if (parsed > 0) directives.maxTurns = Math.min(parsed, MAX_TURNS_CEILING);
    } else if (key === "checkpoint" && directives.checkpoint === null) {
      directives.checkpoint = value;
    } else if (key === "workflow" && directives.workflow === null) {
      directives.workflow = value;
    } else if (key === "effort" && directives.effort === null) {
      // Clamp to the allowlist: a semi-trusted body may pick a level, never
      // name an arbitrary value. An unrecognised value stays null (ignored).
      const level = value.toLowerCase();
      if ((ALLOWED_TICKET_EFFORTS as readonly string[]).includes(level)) {
        directives.effort = level;
      }
    }
  }

  return directives;
}

/**
 * The raw (un-clamped) value of an `effort:` directive in the Workflow
 * section, if present — for surfacing an *ignored* request an operator
 * otherwise couldn't see. Parsing for use goes through parseTicketDirectives,
 * which clamps to the allowlist; this only reports what was asked for.
 */
export function rawEffortDirective(body: string): string | null {
  for (const line of workflowSectionLines(body)) {
    const match = line.match(DIRECTIVE_LINE);
    if (match && match[1].toLowerCase() === "effort") return match[2].trim() || null;
  }
  return null;
}

/**
 * The lines of the ticket's Workflow section, if it has one. Code fences are
 * tracked from the top of the body: a fenced "heading" cannot open the
 * section and fenced lines inside it are examples, not directives.
 */
function workflowSectionLines(body: string): string[] {
  const sectionLines: string[] = [];
  let inSection = false;
  let inFence = false;

  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (!inSection && WORKFLOW_SECTION.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^#{1,3}\s/.test(line)) break;
    if (inSection) sectionLines.push(line);
  }

  return sectionLines;
}

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
