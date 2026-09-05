import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { turnFromClaudeStream } from "@/test/claude-stream-fixture";
import type { PassTurn } from "../pass-output";
import { parseReviewVerdict } from "../verdict";

// Fixtures are the raw stream-json a review pass emits, ending in a `result`
// event whose `result` field is the turn's final message. The parser under
// test takes the adapter's normalised turn result (issue #214), so each
// fixture goes through the Claude Code adapter's own classifier first — the
// only code that reads the stream's exit shape.
function fixture(name: string): PassTurn {
  return turnFromClaudeStream(
    fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8")
  );
}

describe("parseReviewVerdict", () => {
  it("parses an approve verdict from a review pass stream", () => {
    expect(parseReviewVerdict(fixture("verdict-approve.ndjson"))).toEqual({
      kind: "approve",
      body:
        "Verified against issue #7: the change does what the ticket asked, " +
        "tests cover the failure paths, and lint is clean.",
    });
  });

  it("parses a request-changes verdict with its findings as the body", () => {
    expect(parseReviewVerdict(fixture("verdict-request-changes.ndjson"))).toEqual({
      kind: "request-changes",
      body:
        "- The ticket asks for oldest-first ordering; the query sorts by id.\n" +
        "- `parseBlockedByRefs` has no test for the bulleted form the ticket names.",
    });
  });

  it("parses an escalate verdict", () => {
    expect(parseReviewVerdict(fixture("verdict-escalate.ndjson"))).toEqual({
      kind: "escalate",
      body:
        "The work is complete, but it changes when the orchestrator restarts " +
        "during deploys — consequential enough that the owner should look " +
        "before it lands.",
    });
  });

  // Issue #94: models routinely open with a verification summary before the
  // verdict. A good, evidenced review must not be discarded over that layout —
  // the verdict is scanned for, not required at position zero, and the body is
  // what follows it (the preamble is dropped, not posted).
  it("parses an approve verdict preceded by a verification summary", () => {
    expect(
      parseReviewVerdict(fixture("verdict-approve-with-preamble.ndjson"))
    ).toEqual({
      kind: "approve",
      body:
        "Reviewed against issue #7: the change does what the ticket asked, " +
        "tests cover the failure paths, and lint is clean.",
    });
  });

  it("parses a request-changes verdict preceded by a preamble", () => {
    expect(
      parseReviewVerdict(fixture("verdict-request-changes-with-preamble.ndjson"))
    ).toEqual({
      kind: "request-changes",
      body:
        "- The ticket asks for oldest-first ordering; the query sorts by id.\n" +
        "- `parseBlockedByRefs` has no test for the bulleted form the ticket names.",
    });
  });

  // The unparseable cases are the safety property: a review pass that did
  // not deliver a clean VERDICT: line must block the merge, never default
  // toward approval.
  describe("unparseable output", () => {
    // The marker appears mid-sentence ("...my conclusion is VERDICT: approve"),
    // not at the start of any line — line-start anchoring keeps this rejected
    // even though the parser now scans past a preamble (issue #94).
    it("rejects a verdict quoted mid-line rather than starting a line", () => {
      expect(parseReviewVerdict(fixture("verdict-malformed.ndjson"))).toMatchObject({
        kind: "unparseable",
      });
    });

    it("rejects an errored turn even when its final message looks like a verdict", () => {
      expect(parseReviewVerdict(fixture("verdict-errored-turn.ndjson"))).toMatchObject({
        kind: "unparseable",
      });
    });

    it("rejects a stream that ended without a result event", () => {
      expect(parseReviewVerdict(fixture("verdict-truncated.ndjson"))).toMatchObject({
        kind: "unparseable",
      });
    });

    it("rejects a request-changes verdict with no findings to deliver", () => {
      expect(
        parseReviewVerdict(fixture("verdict-request-changes-empty.ndjson"))
      ).toMatchObject({ kind: "unparseable" });
    });

    it("rejects a turn with no outcome and no message", () => {
      expect(parseReviewVerdict(turnFromClaudeStream(""))).toMatchObject({
        kind: "unparseable",
      });
    });
  });
});
