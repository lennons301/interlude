import { describe, it, expect, vi } from "vitest";

// The Claude Code adapter's output handler writes into the feed; nothing here
// exercises it, so the DB is stubbed rather than opened — the same stub the
// adapter's own suite uses.
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/config", () => ({
  getConfig: () => ({ maxTurns: 50, maxBudgetUsd: 20 }),
}));

import {
  composeSeed,
  composeSessionTurn,
  ISSUE_ANCHOR_HINT,
  ARMING_CONVENTION,
  PUBLISHING_SESSION_SKILLS,
  type SkillInvoker,
} from "../seed";
import { SESSION_SKILLS } from "@/db/schema";
import { claudeCodeAdapter } from "@/lib/harness/claude-code";
import { createFakeHarness } from "@/test/fake-harness";

/**
 * Seed composition (issues #63, #218). The framing — issue anchor, arming
 * convention, ordering — is the fleet's and is pinned here verbatim; the
 * invocation line is the lane's adapter's, so the matrix below runs against the
 * real Claude Code adapter (where the output must be byte-identical to the
 * slash the composer used to write itself) and the fake adapter (where the
 * line differs and the framing must not).
 */
const claude: SkillInvoker = claudeCodeAdapter;
const fake: SkillInvoker = createFakeHarness().adapter;

describe("composeSeed — slash passthrough on Claude Code (spike #59)", () => {
  it("emits the bare skill slash for a freeform session with no agenda", () => {
    // Per the #59 spike: the first-turn prompt is the bare slash-command
    // string so the CLI expands the user-invocable skill — no SKILL.md inlining.
    expect(composeSeed({ sessionSkill: "wayfinder" }, claude)).toBe("/wayfinder");
  });

  it("rides the agenda as the skill's argument text on the slash line", () => {
    expect(
      composeSeed({ sessionSkill: "to-spec", agenda: "focus on the auth flow" }, claude)
    ).toBe("/to-spec focus on the auth flow");
  });

  it("treats a blank/whitespace agenda as no agenda", () => {
    expect(composeSeed({ sessionSkill: "to-spec", agenda: "   " }, claude)).toBe("/to-spec");
  });
});

describe("composeSeed — the invocation line is the adapter's (issue #218)", () => {
  it("asks the adapter for the line, handing it the skill and the trimmed agenda", () => {
    const asked: [string, string | null][] = [];
    const recorder: SkillInvoker = {
      composeSkillInvocation(skill, agenda) {
        asked.push([skill, agenda]);
        return `<${skill}|${agenda ?? ""}>`;
      },
    };

    expect(composeSeed({ sessionSkill: "to-spec", agenda: "  the auth flow  " }, recorder)).toBe(
      "<to-spec|the auth flow>"
    );
    expect(composeSeed({ sessionSkill: "wayfinder", agenda: "   " }, recorder)).toBe(
      "<wayfinder|>"
    );
    expect(asked).toEqual([
      ["to-spec", "the auth flow"],
      // A blank agenda reaches the adapter as none, not as whitespace.
      ["wayfinder", null],
    ]);
  });

  it("puts the fake adapter's invocation where the slash would go, framing intact", () => {
    // The fake's line is nothing like a slash. Everything around it — the
    // anchor the agent fetches, the arming convention for a publishing skill,
    // their order — is exactly what a Claude seed carries.
    const seed = composeSeed(
      {
        sessionSkill: "grill-me",
        sessionIssue: "owner/repo#9",
        agenda: "the new billing model",
      },
      fake
    );

    expect(seed).toBe(
      [
        "[fake: load skill grill-me] the new billing model",
        ISSUE_ANCHOR_HINT("owner/repo#9"),
        ARMING_CONVENTION,
      ].join("\n\n")
    );
    expect(seed.startsWith("/")).toBe(false);
  });

  it("composes the same framing for every skill on both adapters, differing only in the first line", () => {
    for (const skill of SESSION_SKILLS) {
      const onClaude = composeSeed(
        { sessionSkill: skill, sessionIssue: "owner/repo#1", agenda: "x" },
        claude
      ).split("\n\n");
      const onFake = composeSeed(
        { sessionSkill: skill, sessionIssue: "owner/repo#1", agenda: "x" },
        fake
      ).split("\n\n");

      expect(onClaude[0]).toBe(`/${skill} x`);
      expect(onFake[0]).toBe(`[fake: load skill ${skill}] x`);
      expect(onFake.slice(1)).toEqual(onClaude.slice(1));
    }
  });
});

describe("composeSeed — issue anchor (reference, not body)", () => {
  it("appends a gh-fetch instruction naming the anchored issue", () => {
    const seed = composeSeed(
      {
        sessionSkill: "triage",
        sessionIssue: "lennons301/interlude#42",
      },
      claude
    );
    expect(seed).toBe(`/triage\n\n${ISSUE_ANCHOR_HINT("lennons301/interlude#42")}`);
  });

  it("omits the anchor block for a freeform session", () => {
    const seed = composeSeed({ sessionSkill: "triage" }, claude);
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
    const seed = composeSeed({ sessionSkill: "to-tickets" }, claude);
    expect(seed).toBe(`/to-tickets\n\n${ARMING_CONVENTION}`);
  });

  it("carries the three arming rules verbatim", () => {
    expect(ARMING_CONVENTION).toContain("unlabelled");
    expect(ARMING_CONVENTION).toContain("only after I confirm");
    expect(ARMING_CONVENTION).toContain("audit comment");
    expect(ARMING_CONVENTION).toContain("ready-for-agent");
  });

  it("omits the arming convention for a non-publishing skill", () => {
    expect(composeSeed({ sessionSkill: "to-spec" }, claude)).not.toContain("Arming convention");
    expect(composeSeed({ sessionSkill: "triage" }, claude)).not.toContain("Arming convention");
    expect(composeSeed({ sessionSkill: "wayfinder" }, claude)).not.toContain(
      "Arming convention"
    );
  });

  it("orders the parts head → anchor → arming for a publishing, anchored session", () => {
    const seed = composeSeed(
      {
        sessionSkill: "grill-me",
        sessionIssue: "owner/repo#9",
        agenda: "the new billing model",
      },
      claude
    );
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

describe("composeSeed on Claude Code — fixture matrix: skill × anchored/freeform × agenda/none", () => {
  // The arming convention is pinned to grill/to-tickets by the ticket — this
  // list is transcribed from the spec, independent of the implementation, so a
  // drift in either direction fails the matrix. The expected strings are the
  // pre-#218 composer's, written out: the Claude lane's seed must not have
  // changed by a byte when the composer started asking the adapter.
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
          const seed = composeSeed(
            {
              sessionSkill: skill,
              sessionIssue: anchored ? REF : null,
              agenda: withAgenda ? AGENDA : null,
            },
            claude
          );
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

describe("composeSessionTurn — follow-on slash routing (#63, #218)", () => {
  it("routes a typed skill slash through the same composition as the seed", () => {
    // A mid-session /to-tickets must invoke the skill exactly as a to-tickets
    // seed would — arming convention included — never improvised from memory.
    expect(composeSessionTurn("/to-tickets", claude)).toBe(
      composeSeed({ sessionSkill: "to-tickets" }, claude)
    );
  });

  it("carries the follow-up's trailing text through as the skill's agenda", () => {
    expect(composeSessionTurn("/to-spec the decisions we just settled", claude)).toBe(
      composeSeed({ sessionSkill: "to-spec", agenda: "the decisions we just settled" }, claude)
    );
  });

  it("passes an ordinary (non-slash) follow-up message through unchanged", () => {
    const msg = "Yes, arm all four — they look right.";
    expect(composeSessionTurn(msg, claude)).toBe(msg);
    expect(composeSessionTurn(msg, fake)).toBe(msg);
  });

  it("passes an unknown slash command through unchanged (not a session skill)", () => {
    expect(composeSessionTurn("/tdd write the test first", claude)).toBe(
      "/tdd write the test first"
    );
    expect(composeSessionTurn("/clear", claude)).toBe("/clear");
    // On a harness with no slash of its own the text is still the owner's to
    // pass through: the composer only knows the session skills.
    expect(composeSessionTurn("/clear", fake)).toBe("/clear");
  });

  it("recognises every session skill as a routable follow-on slash", () => {
    for (const skill of SESSION_SKILLS) {
      expect(composeSessionTurn(`/${skill}`, claude)).toBe(
        composeSeed({ sessionSkill: skill }, claude)
      );
    }
  });

  it("turns the typed slash into the lane's own invocation on another harness", () => {
    // The owner types the slash the composer's menu offers, whatever the lane;
    // what the agent receives is how *its* harness loads the skill.
    expect(composeSessionTurn("/to-tickets batch 3", fake)).toBe(
      ["[fake: load skill to-tickets] batch 3", ARMING_CONVENTION].join("\n\n")
    );
  });
});
