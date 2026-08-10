import { describe, it, expect } from "vitest";
import { detectBlockedQuestion } from "../blocked";

describe("detectBlockedQuestion — positive cases", () => {
  it("returns the question when BLOCKED: is the first line", () => {
    expect(
      detectBlockedQuestion("BLOCKED: Should retries be configurable or fixed at 3?")
    ).toBe("Should retries be configurable or fixed at 3?");
  });

  it("detects the marker after a preamble paragraph — narrate-then-BLOCKED (issue #107)", () => {
    // The real moontide #32 message: a preamble line, a blank line, then the
    // marker. First-line-only detection returned null and the run dangled.
    const moontide =
      "The ticket's premise doesn't hold, and the resolution changes the " +
      "deliverable materially, so I'm stopping rather than guessing.\n\n" +
      "BLOCKED: `README.md` is not empty — it's a deliberate 89-line README. " +
      "Should I cut it down to the minimal three-section README the ticket " +
      "specifies (deleting the existing content)?";

    expect(detectBlockedQuestion(moontide)).toBe(
      "`README.md` is not empty — it's a deliberate 89-line README. Should I " +
        "cut it down to the minimal three-section README the ticket specifies " +
        "(deleting the existing content)?"
    );
  });

  it("detects the marker after a single preamble line", () => {
    expect(
      detectBlockedQuestion(
        "I reviewed the ticket.\nBLOCKED: Should retries be configurable?"
      )
    ).toBe("Should retries be configurable?");
  });

  it("detects the marker preceded by a blank first line", () => {
    expect(detectBlockedQuestion("\nBLOCKED: Should retries be configurable?")).toBe(
      "Should retries be configurable?"
    );
  });

  it("detects the marker after a preceding fenced code block", () => {
    expect(
      detectBlockedQuestion(
        "Here is the diff:\n```\nsome code\n```\nBLOCKED: Should retries be configurable?"
      )
    ).toBe("Should retries be configurable?");
  });
});

describe("detectBlockedQuestion — negative cases (false-positive guards)", () => {
  it("ignores the marker mid-line inside prose", () => {
    expect(
      detectBlockedQuestion(
        'The spec says to emit "BLOCKED: <question>" when stuck, which I did not need.'
      )
    ).toBeNull();
  });

  it("ignores a quoted marker", () => {
    expect(
      detectBlockedQuestion("> BLOCKED: Should retries be configurable?")
    ).toBeNull();
  });

  it("ignores a marker inside a code fence", () => {
    expect(
      detectBlockedQuestion("```\nBLOCKED: Should retries be configurable?\n```")
    ).toBeNull();
  });

  it("ignores an indented marker", () => {
    expect(detectBlockedQuestion("  BLOCKED: Should retries be configurable?")).toBeNull();
  });

  it("ignores a lowercase marker — the contract is uppercase", () => {
    expect(detectBlockedQuestion("blocked: Should retries be configurable?")).toBeNull();
  });

  it("ignores a bolded marker — markdown around it is not the marker", () => {
    expect(detectBlockedQuestion("**BLOCKED:** Should retries be configurable?")).toBeNull();
  });

  it("ignores a marker with no question — there is nothing to ask", () => {
    expect(detectBlockedQuestion("BLOCKED:")).toBeNull();
    expect(detectBlockedQuestion("BLOCKED:   ")).toBeNull();
    expect(
      detectBlockedQuestion("I reviewed the ticket.\nBLOCKED:   ")
    ).toBeNull();
  });

  it("returns null for an empty or missing final message", () => {
    expect(detectBlockedQuestion(null)).toBeNull();
    expect(detectBlockedQuestion("")).toBeNull();
  });
});

describe("detectBlockedQuestion — question extraction", () => {
  it("returns only the marker's line — context below stays in the task chat", () => {
    expect(
      detectBlockedQuestion(
        "BLOCKED: Postgres or SQLite for the cache?\n\nThe ticket names neither and both fit."
      )
    ).toBe("Postgres or SQLite for the cache?");
  });

  it("handles CRLF line endings", () => {
    expect(
      detectBlockedQuestion("BLOCKED: Postgres or SQLite?\r\nMore context.")
    ).toBe("Postgres or SQLite?");
  });
});
