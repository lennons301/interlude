import { SESSION_SKILLS, type SessionSkill } from "@/db/schema";

export interface SeedInput {
  sessionSkill: SessionSkill;
  sessionIssue?: string | null;
  agenda?: string | null;
}

/**
 * Session skills whose pipeline publishes and arms tickets, so their seed
 * carries the arming convention. The ticket (#63) pins this to grill/to-tickets:
 * the grilling family and the ticket-publishing skill are the one conversation
 * (grill → /to-spec → /to-tickets → arm) that ends in armed issues. `to-spec`
 * publishes a spec but arms nothing; `triage` and `wayfinder` never publish
 * tickets — so none of them carry the convention.
 */
export const PUBLISHING_SESSION_SKILLS = [
  "grill-me",
  "grill-with-docs",
  "to-tickets",
] as const satisfies readonly SessionSkill[];

/**
 * The arming convention the workflow contract sanctions for an
 * interactive-session-armed ticket (#63, spec #50): publish unlabelled, arm
 * only on the owner's in-chat confirmation, and leave an audit trail on each
 * armed issue. Carried in the seed of every publishing session so the agent
 * knows it before it reaches the publish/arm step.
 */
export const ARMING_CONVENTION = [
  "Arming convention for this session:",
  "- Publish any tickets unlabelled — never apply `ready-for-agent` at creation.",
  "- Apply `ready-for-agent` only after I confirm the batch in this chat.",
  "- On each issue you arm, post an audit comment recording this Interlude " +
    "session and the confirmation route (owner-confirmed in chat).",
].join("\n");

function isPublishingSkill(skill: SessionSkill): boolean {
  return (PUBLISHING_SESSION_SKILLS as readonly SessionSkill[]).includes(skill);
}

/**
 * The anchor block appended when a session is anchored to an issue. The
 * orchestrator passes only the reference (`owner/repo#n`), never the body — the
 * agent fetches it itself with the per-exec GitHub App token, so upstream skills
 * run unmodified against a real `gh`.
 */
export function ISSUE_ANCHOR_HINT(ref: string): string {
  return (
    `This session is anchored to GitHub issue ${ref}. Fetch it yourself with ` +
    `the \`gh\` CLI before you begin — you have a GitHub App token in this ` +
    `container, and the orchestrator passed only this reference, not the issue body.`
  );
}

export function composeSeed({ sessionSkill, sessionIssue, agenda }: SeedInput): string {
  const trimmedAgenda = agenda?.trim();
  const head = trimmedAgenda
    ? `/${sessionSkill} ${trimmedAgenda}`
    : `/${sessionSkill}`;

  const parts = [head];
  const ref = sessionIssue?.trim();
  if (ref) parts.push(ISSUE_ANCHOR_HINT(ref));
  if (isPublishingSkill(sessionSkill)) parts.push(ARMING_CONVENTION);

  return parts.join("\n\n");
}

/**
 * Route a generation-session follow-up turn. If the message leads with a known
 * session-skill slash (the common `/to-spec` → `/to-tickets` → arm progression),
 * re-frame it through {@link composeSeed} — the same path the seed turn takes —
 * so a typed slash carries the same framing (notably the arming convention for
 * publishing skills) and never silently degrades into the agent improvising the
 * skill from memory. Any other message (plain prose, or a non-session slash the
 * CLI handles itself) passes through unchanged.
 *
 * The #59 spike found the leading slash already expands natively at every turn
 * position, so this adds framing rather than rescuing expansion. A follow-on
 * turn has no separate issue anchor — the session's anchor was set at the seed.
 */
export function composeSessionTurn(rawText: string): string {
  const match = /^\s*\/(\S+)([\s\S]*)$/.exec(rawText);
  if (!match) return rawText;

  const skill = match[1];
  if (!(SESSION_SKILLS as readonly string[]).includes(skill)) return rawText;

  return composeSeed({
    sessionSkill: skill as SessionSkill,
    agenda: match[2].trim() || null,
  });
}
