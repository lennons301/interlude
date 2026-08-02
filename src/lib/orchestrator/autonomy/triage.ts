/**
 * Triage-exit parsing for the triage pass (issue #23) — pure interpretation
 * of a triage container's stream-json output. Triage reads semi-trusted
 * input, so its ceiling is enforced here and in the reducer, not requested
 * in a prompt: the parser can only ever return one of three exits (or
 * unparseable), and `decideNext` maps each exit to a fixed advisory label
 * set that never contains `ready-for-agent`.
 *
 * The contract with the pass prompt: the turn's final message begins, on its
 * first line, with `TRIAGE: recommend | needs-info | ready-for-human`, and
 * the rest of the message is the exit's body — the assessment, the specific
 * questions, or the suggested grilling agenda.
 */

import { finalPassMessage } from "./pass-output";

export type TriageExitKind = "recommend" | "needs-info" | "ready-for-human";

export type TriageResult =
  | { kind: TriageExitKind; body: string }
  | { kind: "unparseable"; reason: string };

const TRIAGE_LINE = /^TRIAGE:[ \t]*(recommend|needs-info|ready-for-human)[ \t]*$/i;

/**
 * Parse a triage pass's raw NDJSON stream into an exit. Every exit needs a
 * non-empty body — an assessment, questions or an agenda are the pass's
 * whole output; a bare marker drives nothing.
 */
/**
 * Whether a Discord reply to a triage recommendation is an explicit arming
 * confirmation. Deliberately strict — exactly "yes", "arm" or "arm it",
 * case-insensitive with trailing punctuation ignored. Prose that merely
 * contains a yes, hedges, and silence are never consent.
 */
export function isArmingConfirmation(reply: string): boolean {
  const normalized = reply
    .trim()
    .toLowerCase()
    .replace(/[.!\s]+$/, "");
  return normalized === "yes" || normalized === "arm" || normalized === "arm it";
}

export function parseTriageExit(ndjson: string): TriageResult {
  const final = finalPassMessage(ndjson);
  if (!final.ok) {
    return { kind: "unparseable", reason: `triage ${final.reason}` };
  }

  const lines = final.message.trim().split("\n");
  const match = lines[0].trim().match(TRIAGE_LINE);
  if (!match) {
    return {
      kind: "unparseable",
      reason: "final message does not start with a TRIAGE: line",
    };
  }

  const kind = match[1].toLowerCase() as TriageExitKind;
  const body = lines.slice(1).join("\n").trim();

  if (!body) {
    return { kind: "unparseable", reason: `${kind} exit has no body` };
  }

  return { kind, body };
}
