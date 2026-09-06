import { SESSION_SKILLS, type SessionSkill } from "@/db/schema";
import type { HarnessAdapter } from "@/lib/harness/adapter";

export interface SeedInput {
  sessionSkill: SessionSkill;
  sessionIssue?: string | null;
  agenda?: string | null;
}

/**
 * The one thing the composer needs of a harness (issue #218): how *this*
 * harness is asked to load a skill. One harness expands a slash natively (the
 * #59 spike); another mentions the skill by name; a harness that loads skills
 * through a tool is told to. The composer used to write the slash itself,
 * which made every generation session one harness's by construction — so it
 * asks the lane's adapter now, and the framing around the line (issue anchor,
 * arming convention) is the same on every harness while the line itself
 * differs.
 *
 * A structural pick rather than the whole adapter, so a test can hand in a
 * two-line double and the turn manager can hand in the real thing.
 */
export type SkillInvoker = Pick<HarnessAdapter, "composeSkillInvocation">;

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

/**
 * The first turn of a generation session: the harness's own invocation of the
 * session skill (with the agenda as its argument), then the issue anchor if
 * the session has one, then the arming convention if the skill publishes.
 *
 * The invocation line is the adapter's (issue #218) and the framing is the
 * fleet's: the same seed carries the same anchor and the same convention on
 * every harness, and only the first line says how that harness loads a skill.
 * On a harness that expands a slash the line is the slash the composer always
 * emitted, so a seed composed for a lane on the first adapter is
 * byte-identical to what it was before the adapter was asked.
 */
export function composeSeed(
  { sessionSkill, sessionIssue, agenda }: SeedInput,
  adapter: SkillInvoker
): string {
  const trimmedAgenda = agenda?.trim();
  const head = adapter.composeSkillInvocation(sessionSkill, trimmedAgenda || null);

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
 * harness handles itself) passes through unchanged.
 *
 * The slash is the *composer's* vocabulary — what the owner types, and what
 * the live composer's menu offers (issue #122) — on every harness. What
 * reaches the agent is the adapter's invocation (issue #218): on a harness
 * that expands a slash, the same slash, which the #59 spike found expands natively at every turn
 * position, so there this adds framing rather than rescuing expansion; on a
 * harness that does not expand a slash, the text that makes it load the skill.
 * A follow-on turn has no separate issue anchor — the session's anchor was set
 * at the seed.
 */
export function composeSessionTurn(rawText: string, adapter: SkillInvoker): string {
  const match = /^\s*\/(\S+)([\s\S]*)$/.exec(rawText);
  if (!match) return rawText;

  const skill = match[1];
  if (!(SESSION_SKILLS as readonly string[]).includes(skill)) return rawText;

  return composeSeed(
    {
      sessionSkill: skill as SessionSkill,
      agenda: match[2].trim() || null,
    },
    adapter
  );
}
