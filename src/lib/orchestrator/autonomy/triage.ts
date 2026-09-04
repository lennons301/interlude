/**
 * Pure interpretation on the triage pass's boundaries (issue #23): parsing
 * a triage container's stream-json output into an exit, and recognising the
 * owner's explicit arming confirmation in Discord. Triage reads semi-trusted
 * input, so its ceiling is enforced here and in the reducer, not requested
 * in a prompt: the parser can only ever return one of three exits (or
 * unparseable), and `decideNext` maps each exit to a fixed advisory label
 * set that never contains `ready-for-agent`.
 *
 * The contract with the pass prompt: the turn's final message begins, on its
 * first line, with `TRIAGE: recommend | needs-info | ready-for-human`; an
 * optional `TIER: light | standard | heavy` line follows it (issue #200);
 * and the rest of the message is the exit's body — the assessment, the
 * specific questions, or the suggested grilling agenda.
 */

import { normalizeModelTier, type ModelTier } from "@/lib/model-tiers";
import { finalPassMessage } from "./pass-output";

export type TriageExitKind = "recommend" | "needs-info" | "ready-for-human";

export type TriageResult =
  | {
      kind: TriageExitKind;
      body: string;
      /** The tier triage suggests for the issue's work (issue #200), read
       * from the exit's `TIER:` line and clamped to the tier vocabulary — a
       * pass may pick a tier, never name a model. Null when the line is
       * absent or names no tier: a missing or mistyped suggestion leaves the
       * suggestion empty and the verdict intact. */
      tier: ModelTier | null;
    }
  | { kind: "unparseable"; reason: string };

/**
 * The exit as stored on `tasks.triageResult`: rows written before issue #200
 * carry no `tier` key. `readStoredTriageResult` is the one reader that turns
 * a row back into a `TriageResult`, re-clamping the stored word to the tier
 * vocabulary on the way — a row is data, and the reducer only ever sees a
 * tier or null.
 */
export type StoredTriageResult =
  | { kind: TriageExitKind; body: string; tier?: ModelTier | null }
  | { kind: "unparseable"; reason: string };

export function readStoredTriageResult(stored: StoredTriageResult): TriageResult {
  if (stored.kind === "unparseable") return stored;
  return { kind: stored.kind, body: stored.body, tier: normalizeModelTier(stored.tier) };
}

const TRIAGE_LINE = /^TRIAGE:[ \t]*(recommend|needs-info|ready-for-human)[ \t]*$/i;
/**
 * Case-sensitive where the exit marker above is not, because the two fail in
 * opposite directions. A `TRIAGE:` marker missed on case would fail the
 * whole exit closed, so it tolerates one. A `TIER:` marker is consumed out of
 * the body, so a false match would silently eat the first line of an
 * assessment that happened to open "Tier: …" in prose — while a real line
 * written in the wrong case costs only the suggestion, and stays visible in
 * the body posted to the issue.
 */
const TIER_LINE = /^TIER:[ \t]*(.*?)[ \t]*$/;

/**
 * Parse a triage pass's raw NDJSON stream into an exit. Every exit needs a
 * non-empty body — an assessment, questions or an agenda are the pass's
 * whole output; a bare marker drives nothing. The `TIER:` line, when the
 * pass wrote one, is the first non-blank line after the marker, in the
 * marker's own upper case; it is consumed rather than left in the body, and
 * a value outside the tier vocabulary reads as no suggestion — never as a
 * fourth exit and never as a failure, because the tier is advice about the
 * work and the exit is the decision about the issue.
 */
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

  let bodyStart = 1;
  while (bodyStart < lines.length && lines[bodyStart].trim() === "") bodyStart++;
  let tier: ModelTier | null = null;
  const tierMatch = lines[bodyStart]?.trim().match(TIER_LINE);
  if (tierMatch) {
    tier = normalizeModelTier(tierMatch[1]);
    bodyStart++;
  }

  const body = lines.slice(bodyStart).join("\n").trim();

  if (!body) {
    return { kind: "unparseable", reason: `${kind} exit has no body` };
  }

  return { kind, body, tier };
}

/** Who chose a run's tier (issue #200): the ticket's own `model:` directive,
 * or the triage pass's stored suggestion filling the gap the body left. */
export type TierSource = "ticket" | "triage";

/**
 * The tier a run will use, and where it came from (issue #200). Null means
 * neither the ticket nor triage stated one, so the run resolves to the
 * configured default exactly as a ticket with no directive always has.
 */
export type RunTierChoice = { tier: ModelTier; source: TierSource } | null;

/**
 * Precedence between a ticket's own `model:` directive and the tier its
 * triage pass suggested — written once, so the claim that pins the run's
 * tier and the recommendation that tells the operator which tier the run
 * will use cannot disagree. Triage fills the gap and never overrides it: a
 * tier stated in the body always outranks the stored suggestion, and the
 * suggestion applies only where the body states none. A pass that read the
 * ticket cold may not silently overrule what the operator wrote.
 */
export function chooseRunTier(
  ticketTier: ModelTier | null,
  suggestedTier: ModelTier | null
): RunTierChoice {
  if (ticketTier !== null) return { tier: ticketTier, source: "ticket" };
  if (suggestedTier !== null) return { tier: suggestedTier, source: "triage" };
  return null;
}

/**
 * Whether a Discord reply to a triage recommendation is an explicit arming
 * confirmation — the other pure interpretation on triage's arming boundary.
 * Deliberately strict: exactly "yes" (case-insensitive, trailing punctuation
 * ignored), the word the recommendation asks for. Prose that merely contains
 * a yes, hedges, and silence are never consent.
 */
export function isArmingConfirmation(reply: string): boolean {
  const normalized = reply
    .trim()
    .toLowerCase()
    .replace(/[.!\s]+$/, "");
  return normalized === "yes";
}
