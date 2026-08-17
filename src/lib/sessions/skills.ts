import { type SessionSkill } from "@/db/schema";

/**
 * One-line blurbs for the estate's generation skills — the copy that says what
 * each session is *for*. Keyed by SessionSkill, so a skill added to the schema
 * fails the type check here until it gets a blurb: no surface can silently drop
 * one. Insertion order is the display order (grills first, then the
 * spec→tickets pipeline, then the standalone passes); SESSION_SKILLS in the
 * schema stays the runtime source of truth.
 *
 * Shared rather than restated: the session-entry form (issue #64) and the live
 * composer's slash menu (issue #122) offer the same six skills, and two copies
 * of these strings would drift the moment one is edited.
 */
export const SESSION_BLURBS: Record<SessionSkill, string> = {
  "grill-me": "Stress-test an idea until its decisions resolve",
  "grill-with-docs": "Grill an idea with the project's docs in context",
  "to-spec": "Turn resolved decisions into a spec",
  "to-tickets": "Decompose a spec into executable tickets",
  triage: "Move an issue through the label lifecycle",
  wayfinder: "Chart a new map of the territory",
};

export const SESSION_ORDER = Object.keys(SESSION_BLURBS) as SessionSkill[];
