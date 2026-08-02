import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { isArmingConfirmation, parseTriageExit } from "../triage";

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
    });
  });

  it("parses a needs-info exit with the questions as the body", () => {
    expect(parseTriageExit(fixture("triage-needs-info.ndjson"))).toEqual({
      kind: "needs-info",
      body:
        "- Which page should the export button live on — the task list or the task detail view?\n" +
        "- CSV or JSON, and does the export include archived tasks?",
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
