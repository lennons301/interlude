import { describe, expect, it } from "vitest";
import {
  decideSessionCarry,
  type SessionCarryInput,
  type SessionDestination,
  type SessionOrigin,
} from "../session-carry";

/**
 * Whether a continued pass may resume its predecessor's conversation (issue
 * #217): the pure decision `restoreSessionTranscript` carries out. The turn
 * manager's suites drive the seam over a real database; these pin the rule and
 * the words, case by case, with nothing else in the way.
 */

const CLAUDE: SessionOrigin = {
  laneId: "claude-subscription",
  laneLabel: "Claude subscription (Pro)",
  adapterId: "claude-code",
};

function onto(overrides: Partial<SessionDestination> = {}): SessionDestination {
  return {
    laneId: "openrouter",
    laneLabel: "OpenRouter",
    adapterId: "claude-code",
    sessionResume: true,
    ...overrides,
  };
}

function decide(overrides: Partial<SessionCarryInput> = {}) {
  return decideSessionCarry({
    sessionId: "sess-1",
    storedAdapter: "claude-code",
    from: CLAUDE,
    to: onto(),
    ...overrides,
  });
}

describe("carrying a session between lanes on the same adapter", () => {
  it("restores when the harness is the same on both ends and the transcript is stored", () => {
    expect(decide()).toEqual({ kind: "restore", sessionId: "sess-1" });
  });

  it("starts fresh, and says so, when nothing was stored for the run", () => {
    const carry = decide({ storedAdapter: null });

    expect(carry).toMatchObject({ kind: "fresh", reason: "not-kept" });
    expect(carry.kind === "fresh" && carry.note).toContain(
      "Resuming without the paused session's transcript"
    );
  });

  it("says nothing for a continuation queued without a session", () => {
    // A degrade carries none by design; a pause whose copy failed already said
    // so on the refused pass's feed and on the issue.
    expect(decide({ sessionId: null, storedAdapter: null })).toEqual({
      kind: "fresh",
      reason: "none-carried",
      note: null,
    });
  });
});

describe("a move across two different adapters (issue #217)", () => {
  const codex = onto({ laneId: "codex-lane", laneLabel: "Codex (OpenAI)", adapterId: "codex" });

  it("refuses the transcript and names both lanes and both harnesses", () => {
    const carry = decide({ to: codex });

    expect(carry).toMatchObject({ kind: "fresh", reason: "different-adapter" });
    const note = carry.kind === "fresh" ? carry.note! : "";
    expect(note).toContain("Claude subscription (Pro)");
    expect(note).toContain("claude-code");
    expect(note).toContain("Codex (OpenAI)");
    expect(note).toContain("codex");
    expect(note).toContain("cannot be carried between two different harnesses");
    // The cost is stated as the ticket states it.
    expect(note).toContain("costs the conversation, not the attempt");
  });

  it("says nothing for a continuation queued without a session, even across adapters", () => {
    // Nothing was meant to carry — a degrade, or a pause whose copy failed —
    // and that was said at the time; which lane the continuation lands on does
    // not make it news.
    expect(decide({ to: codex, sessionId: null, storedAdapter: null })).toEqual({
      kind: "fresh",
      reason: "none-carried",
      note: null,
    });
  });

  it("trusts the store's own manifest over a lane file that re-pointed a lane id", () => {
    // The lineage says the same adapter; the artefacts on disk say otherwise.
    // Whichever is right, resuming them against this harness fails the pass,
    // so the answer is the fresh start, naming the harness that wrote them.
    const carry = decide({ storedAdapter: "codex" });

    expect(carry).toMatchObject({ kind: "fresh", reason: "different-adapter" });
    expect(carry.kind === "fresh" && carry.note).toContain("a codex session");
  });
});

describe("a harness that declares no session resume (issue #217)", () => {
  const noResume = onto({
    laneId: "opencode-lane",
    laneLabel: "OpenCode",
    adapterId: "opencode",
    sessionResume: false,
  });

  it("starts fresh with the note whether or not anything was stored", () => {
    for (const input of [
      { sessionId: "sess-1", storedAdapter: "opencode" },
      { sessionId: null, storedAdapter: null },
    ]) {
      const carry = decide({ ...input, from: { ...CLAUDE, adapterId: "opencode" }, to: noResume });

      expect(carry).toMatchObject({ kind: "fresh", reason: "no-session-resume" });
      const note = carry.kind === "fresh" ? carry.note! : "";
      expect(note).toContain("OpenCode runs opencode, which cannot resume a session");
      expect(note).toContain("no prior context");
    }
  });

  it("is judged before the origin — it is certain whatever the conversation came from", () => {
    expect(
      decide({ to: noResume, from: { laneId: "gone", laneLabel: null, adapterId: null } })
    ).toMatchObject({ reason: "no-session-resume" });
  });

  it("is the one reason said even for a continuation queued without a session", () => {
    // A run on such a lane pauses with nothing copied out, so its resume
    // carries no session — and the spec wants that resume to get this note.
    expect(
      decide({ to: noResume, from: { ...CLAUDE, adapterId: "opencode" }, sessionId: null, storedAdapter: null })
    ).toMatchObject({ reason: "no-session-resume" });
  });
});

describe("a conversation from a lane the file no longer declares", () => {
  const gone: SessionOrigin = { laneId: "retired-lane", laneLabel: null, adapterId: null };

  it("is not carried, and the note names the lane", () => {
    const carry = decide({ from: gone });

    expect(carry).toMatchObject({ kind: "fresh", reason: "lane-unknown" });
    expect(carry.kind === "fresh" && carry.note).toContain("(retired-lane) is no longer declared");
  });

  it("says nothing when no session was queued to begin with", () => {
    expect(decide({ from: gone, sessionId: null, storedAdapter: null })).toEqual({
      kind: "fresh",
      reason: "none-carried",
      note: null,
    });
  });
});
