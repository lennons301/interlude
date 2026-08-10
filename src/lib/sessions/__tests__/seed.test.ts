import { describe, it, expect } from "vitest";
import {
  composeSeed,
  composeSessionTurn,
  ISSUE_ANCHOR_HINT,
  ARMING_CONVENTION,
  PUBLISHING_SESSION_SKILLS,
} from "../seed";
import { SESSION_SKILLS } from "@/db/schema";

describe("composeSeed — slash passthrough (spike #59)", () => {
  it("emits the bare skill slash for a freeform session with no agenda", () => {
    // Per the #59 spike: the first-turn prompt is the bare slash-command
    // string so the CLI expands the user-invocable skill — no SKILL.md inlining.
    expect(composeSeed({ sessionSkill: "wayfinder" })).toBe("/wayfinder");
  });

  it("rides the agenda as the skill's argument text on the slash line", () => {
    expect(
      composeSeed({ sessionSkill: "to-spec", agenda: "focus on the auth flow" })
    ).toBe("/to-spec focus on the auth flow");
  });

  it("treats a blank/whitespace agenda as no agenda", () => {
    expect(composeSeed({ sessionSkill: "to-spec", agenda: "   " })).toBe("/to-spec");
  });
});

describe("composeSeed — issue anchor (reference, not body)", () => {
  it("appends a gh-fetch instruction naming the anchored issue", () => {
    const seed = composeSeed({
      sessionSkill: "triage",
      sessionIssue: "lennons301/interlude#42",
    });
    expect(seed).toBe(`/triage\n\n${ISSUE_ANCHOR_HINT("lennons301/interlude#42")}`);
  });

  it("omits the anchor block for a freeform session", () => {
    const seed = composeSeed({ sessionSkill: "triage" });
    expect(seed).toBe("/triage");
    expect(seed).not.toContain("gh");
  });

  it("passes only the reference, never a fetched body, and tells the agent to fetch", () => {
    const hint = ISSUE_ANCHOR_HINT("owner/repo#7");
    expect(hint).toContain("owner/repo#7");
    expect(hint).toContain("gh");
    expect(hint.toLowerCase()).toContain("fetch");
  });
});

describe("composeSeed — arming convention (publishing skills)", () => {
  it("names grill and to-tickets as the publishing skills", () => {
    // The ticket pins the arming convention to grill/to-tickets sessions: the
    // grilling family and the ticket-publishing skill share one pipeline that
    // ends in armed issues.
    expect([...PUBLISHING_SESSION_SKILLS].sort()).toEqual(
      ["grill-me", "grill-with-docs", "to-tickets"].sort()
    );
  });

  it("appends the arm-on-confirmation + audit-comment convention for a publishing skill", () => {
    const seed = composeSeed({ sessionSkill: "to-tickets" });
    expect(seed).toBe(`/to-tickets\n\n${ARMING_CONVENTION}`);
  });

  it("carries the three arming rules verbatim", () => {
    expect(ARMING_CONVENTION).toContain("unlabelled");
    expect(ARMING_CONVENTION).toContain("only after I confirm");
    expect(ARMING_CONVENTION).toContain("audit comment");
    expect(ARMING_CONVENTION).toContain("ready-for-agent");
  });

  it("omits the arming convention for a non-publishing skill", () => {
    expect(composeSeed({ sessionSkill: "to-spec" })).not.toContain("Arming convention");
    expect(composeSeed({ sessionSkill: "triage" })).not.toContain("Arming convention");
    expect(composeSeed({ sessionSkill: "wayfinder" })).not.toContain("Arming convention");
  });

  it("orders the parts head → anchor → arming for a publishing, anchored session", () => {
    const seed = composeSeed({
      sessionSkill: "grill-me",
      sessionIssue: "owner/repo#9",
      agenda: "the new billing model",
    });
    expect(seed).toBe(
      [
        "/grill-me the new billing model",
        ISSUE_ANCHOR_HINT("owner/repo#9"),
        ARMING_CONVENTION,
      ].join("\n\n")
    );
  });
});

describe("seed building blocks — exact literal content (spec #50/#63)", () => {
  it("pins the arming convention verbatim", () => {
    expect(ARMING_CONVENTION).toBe(
      [
        "Arming convention for this session:",
        "- Publish any tickets unlabelled — never apply `ready-for-agent` at creation.",
        "- Apply `ready-for-agent` only after I confirm the batch in this chat.",
        "- On each issue you arm, post an audit comment recording this Interlude session and the confirmation route (owner-confirmed in chat).",
      ].join("\n")
    );
  });

  it("pins the issue-anchor hint verbatim", () => {
    expect(ISSUE_ANCHOR_HINT("owner/repo#1")).toBe(
      "This session is anchored to GitHub issue owner/repo#1. Fetch it yourself " +
        "with the `gh` CLI before you begin — you have a GitHub App token in this " +
        "container, and the orchestrator passed only this reference, not the issue body."
    );
  });
});

describe("composeSeed — fixture matrix: skill × anchored/freeform × agenda/none", () => {
  // The arming convention is pinned to grill/to-tickets by the ticket — this
  // list is transcribed from the spec, independent of the implementation, so a
  // drift in either direction fails the matrix.
  const PUBLISHING = ["grill-me", "grill-with-docs", "to-tickets"];
  const REF = "lennons301/interlude#42";
  const AGENDA = "the new billing model";

  function expected(skill: string, anchored: boolean, withAgenda: boolean): string {
    const parts = [withAgenda ? `/${skill} ${AGENDA}` : `/${skill}`];
    if (anchored) parts.push(ISSUE_ANCHOR_HINT(REF));
    if (PUBLISHING.includes(skill)) parts.push(ARMING_CONVENTION);
    return parts.join("\n\n");
  }

  for (const skill of SESSION_SKILLS) {
    for (const anchored of [false, true]) {
      for (const withAgenda of [false, true]) {
        const label = `${skill} · ${anchored ? "anchored" : "freeform"} · ${
          withAgenda ? "agenda" : "none"
        }`;
        it(label, () => {
          const seed = composeSeed({
            sessionSkill: skill,
            sessionIssue: anchored ? REF : null,
            agenda: withAgenda ? AGENDA : null,
          });
          expect(seed).toBe(expected(skill, anchored, withAgenda));
          // Invariants the exact string also guarantees, stated for intent:
          expect(seed.startsWith(`/${skill}`)).toBe(true); // slash-first → CLI expands it
          expect(seed.includes("gh")).toBe(anchored); // anchor block iff anchored
          expect(seed.includes("Arming convention")).toBe(PUBLISHING.includes(skill));
        });
      }
    }
  }
});

describe("composeSessionTurn — follow-on slash routing (#63)", () => {
  it("routes a typed skill slash through the same composition as the seed", () => {
    // A mid-session /to-tickets must invoke the skill exactly as a to-tickets
    // seed would — arming convention included — never improvised from memory.
    expect(composeSessionTurn("/to-tickets")).toBe(
      composeSeed({ sessionSkill: "to-tickets" })
    );
  });

  it("carries the follow-up's trailing text through as the skill's agenda", () => {
    expect(composeSessionTurn("/to-spec the decisions we just settled")).toBe(
      composeSeed({ sessionSkill: "to-spec", agenda: "the decisions we just settled" })
    );
  });

  it("passes an ordinary (non-slash) follow-up message through unchanged", () => {
    const msg = "Yes, arm all four — they look right.";
    expect(composeSessionTurn(msg)).toBe(msg);
  });

  it("passes an unknown slash command through unchanged (not a session skill)", () => {
    expect(composeSessionTurn("/tdd write the test first")).toBe(
      "/tdd write the test first"
    );
    expect(composeSessionTurn("/clear")).toBe("/clear");
  });

  it("recognises every session skill as a routable follow-on slash", () => {
    for (const skill of SESSION_SKILLS) {
      expect(composeSessionTurn(`/${skill}`)).toBe(composeSeed({ sessionSkill: skill }));
    }
  });
});
