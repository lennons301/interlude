import { describe, it, expect } from "vitest";
import { detectBlockedQuestion } from "../blocked";

describe("detectBlockedQuestion — positive cases", () => {
  it("returns the question when BLOCKED: is the first line", () => {
    expect(
      detectBlockedQuestion("BLOCKED: Should retries be configurable or fixed at 3?")
    ).toBe("Should retries be configurable or fixed at 3?");
  });
});

describe("detectBlockedQuestion — negative cases (biased toward false negatives)", () => {
  it("ignores the marker mid-message", () => {
    expect(
      detectBlockedQuestion(
        "I reviewed the ticket.\nBLOCKED: Should retries be configurable?"
      )
    ).toBeNull();
  });

  it("ignores a quoted marker", () => {
    expect(
      detectBlockedQuestion("> BLOCKED: Should retries be configurable?")
    ).toBeNull();
  });

  it("ignores a marker mentioned inside first-line prose", () => {
    expect(
      detectBlockedQuestion(
        'The spec says to emit "BLOCKED: <question>" when stuck, which I did not need.'
      )
    ).toBeNull();
  });

  it("ignores a marker inside a code fence", () => {
    expect(
      detectBlockedQuestion("```\nBLOCKED: Should retries be configurable?\n```")
    ).toBeNull();
  });

  it("ignores a marker preceded by a blank first line", () => {
    expect(detectBlockedQuestion("\nBLOCKED: Should retries be configurable?")).toBeNull();
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
  });

  it("returns null for an empty or missing final message", () => {
    expect(detectBlockedQuestion(null)).toBeNull();
    expect(detectBlockedQuestion("")).toBeNull();
  });
});

describe("detectBlockedQuestion — question extraction", () => {
  it("returns only the first line — context below stays in the task chat", () => {
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
