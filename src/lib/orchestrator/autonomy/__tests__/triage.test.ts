import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  chooseRunTier,
  isArmingConfirmation,
  parseTriageExit,
  readStoredTriageResult,
} from "../triage";

// Fixtures follow the shape of __tests__/stream-fixture.ndjson: the raw
// stream-json a triage pass emits, ending in a `result` event whose `result`
// field is the turn's final message.
function fixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
}

describe("parseTriageExit", () => {
  it("parses a recommend exit with the assessment as the body", () => {
    expect(parseTriageExit(fixture("triage-recommend.ndjson"))).toEqual({
      kind: "recommend",
      body:
        "Well specified: names the file, the behaviour and the done-signal. " +
        "Fits the existing frobnicator module; no open questions.",
      tier: null,
    });
  });

  it("parses a needs-info exit with the questions as the body", () => {
    expect(parseTriageExit(fixture("triage-needs-info.ndjson"))).toEqual({
      kind: "needs-info",
      body:
        "- Which page should the export button live on — the task list or the task detail view?\n" +
        "- CSV or JSON, and does the export include archived tasks?",
      tier: null,
    });
  });

  it("parses a ready-for-human exit with the grilling agenda as the body", () => {
    expect(parseTriageExit(fixture("triage-ready-for-human.ndjson"))).toEqual({
      kind: "ready-for-human",
      body:
        "Suggested grilling agenda:\n" +
        "1. What breaks with SQLite today — is this a real limit or a preference?\n" +
        "2. Migration story for the existing WAL database and backups.\n" +
        "3. Who operates the new server, and what does it cost?",
      tier: null,
    });
  });

  // The suggested tier (issue #200): a second structured line the reducer
  // applies at claim where the ticket body states no tier. It is consumed
  // out of the body, so the assessment posted to the issue does not carry a
  // stray `TIER:` line.
  describe("the TIER: line", () => {
    it("carries a suggested tier alongside the verdict, consumed out of the body", () => {
      expect(parseTriageExit(fixture("triage-recommend-tier.ndjson"))).toEqual({
        kind: "recommend",
        body:
          "Well specified: names the file, the behaviour and the done-signal. " +
          "The change is determined by the spec.",
        tier: "light",
      });
    });

    it("accepts the line after a blank, on any exit, and resolves a legacy alias", () => {
      expect(parseTriageExit(fixture("triage-needs-info-tier-alias.ndjson"))).toEqual({
        kind: "needs-info",
        body:
          "- Which storage engine replaces SQLite, and who operates it?\n" +
          "- Is the WAL database migrated or started fresh?",
        tier: "heavy",
      });
    });

    it("leaves the suggestion empty for a value outside the tier vocabulary, without failing the verdict", () => {
      // A pass may pick a tier, never name a model — the same clamp the
      // directive parser applies to a ticket body.
      expect(parseTriageExit(fixture("triage-recommend-bad-tier.ndjson"))).toEqual({
        kind: "recommend",
        body: "Well specified: names the page, the format and the done-signal.",
        tier: null,
      });
    });

    it("still requires a body — a tier is advice about the work, not the exit's output", () => {
      expect(parseTriageExit(fixture("triage-tier-no-body.ndjson"))).toMatchObject({
        kind: "unparseable",
      });
    });
  });

  // The unparseable cases are the safety property: triage's exit vocabulary
  // is exactly three, and nothing a pass emits can widen it. In particular a
  // pass claiming the arming exit itself must come out unparseable, never as
  // a fourth kind.
  describe("unparseable output", () => {
    it("rejects a pass that tries to exit TRIAGE: ready-for-agent", () => {
      expect(parseTriageExit(fixture("triage-armed-exit.ndjson"))).toMatchObject({
        kind: "unparseable",
      });
    });

    it("rejects an exit mentioned mid-message rather than on the first line", () => {
      expect(parseTriageExit(fixture("triage-malformed.ndjson"))).toMatchObject({
        kind: "unparseable",
      });
    });

    it("rejects an errored turn even when its final message looks like an exit", () => {
      expect(parseTriageExit(fixture("triage-errored-turn.ndjson"))).toMatchObject({
        kind: "unparseable",
      });
    });

    it("rejects an exit with no body — questions, agenda or assessment are the output", () => {
      expect(parseTriageExit(fixture("triage-empty-body.ndjson"))).toMatchObject({
        kind: "unparseable",
      });
    });

    it("rejects empty input", () => {
      expect(parseTriageExit("")).toMatchObject({ kind: "unparseable" });
    });
  });
});

describe("readStoredTriageResult", () => {
  it("coalesces a row written before the tier existed to no suggestion", () => {
    // A stored exit from before issue #200 carries no `tier` key at all.
    expect(readStoredTriageResult({ kind: "recommend", body: "Fine." })).toEqual({
      kind: "recommend",
      body: "Fine.",
      tier: null,
    });
  });

  it("re-clamps the stored word to the vocabulary and passes an unparseable exit through", () => {
    expect(
      readStoredTriageResult({ kind: "needs-info", body: "Which?", tier: "light" })
    ).toEqual({ kind: "needs-info", body: "Which?", tier: "light" });
    expect(readStoredTriageResult({ kind: "unparseable", reason: "no line" })).toEqual({
      kind: "unparseable",
      reason: "no line",
    });
  });
});

describe("chooseRunTier", () => {
  // Triage fills the gap and never overrides it (issue #200): the one
  // statement of precedence the claim and the recommendation embed share.
  it("lets a tier stated in the ticket body outrank the stored suggestion", () => {
    expect(chooseRunTier("heavy", "light")).toEqual({ tier: "heavy", source: "ticket" });
  });

  it("applies the suggestion only where the body states no tier", () => {
    expect(chooseRunTier(null, "light")).toEqual({ tier: "light", source: "triage" });
  });

  it("chooses nothing when neither states a tier — the run keeps its configured default", () => {
    expect(chooseRunTier(null, null)).toBeNull();
  });
});

describe("isArmingConfirmation", () => {
  // Silence is never consent, and neither is anything short of an explicit
  // yes: this matcher is what stands between a Discord reply and the
  // orchestrator applying ready-for-agent on the owner's behalf.
  it.each(["yes", "Yes", "YES.", "yes!", "  yes  "])(
    "accepts the explicit confirmation %j",
    (reply) => {
      expect(isArmingConfirmation(reply)).toBe(true);
    }
  );

  it.each([
    "",
    "   ",
    "no",
    "yesterday's build broke",
    "yes but let me look first",
    "yes please",
    "y",
    "ok",
    "👍",
    "arm it",
    "don't arm it",
  ])("rejects %j — not an explicit confirmation", (reply) => {
    expect(isArmingConfirmation(reply)).toBe(false);
  });
});
