import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { parseReviewVerdict } from "../verdict";

// Fixtures follow the shape of __tests__/stream-fixture.ndjson: the raw
// stream-json a review pass emits, ending in a `result` event whose `result`
// field is the turn's final message.
function fixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
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

  // The unparseable cases are the safety property: a review pass that did
  // not deliver a clean first-line marker must block the merge, never
  // default toward approval.
  describe("unparseable output", () => {
    it("rejects a verdict mentioned mid-message rather than on the first line", () => {
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

    it("rejects empty input", () => {
      expect(parseReviewVerdict("")).toMatchObject({ kind: "unparseable" });
    });
  });
});
