import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { turnFromClaudeStream } from "@/test/claude-stream-fixture";
import { finalPassMessage, passProducedResult } from "../pass-output";

// Fixtures are the raw stream-json a pass emits, ending (when it finishes
// cleanly) in a `result` event whose `result` field is the turn's final
// message. The readers under test take the adapter's normalised turn result
// (issue #214), so each fixture goes through the Claude Code adapter's own
// classifier first — the only code that reads the stream's exit shape.
function fixture(name: string) {
  return turnFromClaudeStream(
    fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8")
  );
}

describe("finalPassMessage", () => {
  it("extracts the final message from a completed turn", () => {
    expect(finalPassMessage(fixture("verdict-approve.ndjson"))).toMatchObject({
      ok: true,
    });
  });

  it("fails on a turn that never reached a result event", () => {
    expect(finalPassMessage(fixture("verdict-truncated.ndjson"))).toMatchObject({
      ok: false,
    });
  });

  // The vocabulary is the adapter's, so the boundary is stated in it: only a
  // `completed` turn delivers an exit, whatever its last words were.
  it("fails on every outcome but completed, naming the outcome", () => {
    const message = "VERDICT: approve\n\nLooks fine.";
    expect(
      finalPassMessage({ outcome: { kind: "turn-limit" }, finalMessage: message })
    ).toEqual({ ok: false, reason: "pass did not complete cleanly (turn limit reached)" });
    expect(
      finalPassMessage({
        outcome: {
          kind: "refused",
          refusal: { kind: "quota", resumeAfter: null, limitType: "five_hour" },
        },
        finalMessage: message,
      })
    ).toEqual({ ok: false, reason: "pass did not complete cleanly (refused: quota)" });
    expect(
      finalPassMessage({
        outcome: { kind: "failed", reason: "error_during_execution" },
        finalMessage: message,
      })
    ).toEqual({
      ok: false,
      reason: "pass did not complete cleanly (error_during_execution)",
    });
    expect(
      finalPassMessage({ outcome: { kind: "failed", reason: null }, finalMessage: message })
    ).toEqual({ ok: false, reason: "pass did not complete cleanly (harness error)" });
  });

  it("fails on a completed turn that carries no final message", () => {
    expect(
      finalPassMessage({ outcome: { kind: "completed" }, finalMessage: null })
    ).toEqual({ ok: false, reason: "result event carries no final message" });
    expect(
      finalPassMessage({ outcome: { kind: "completed" }, finalMessage: "   " })
    ).toMatchObject({ ok: false });
  });
});

// The classifier the interruption-vs-failure split hangs on (issue #97): a
// turn with an outcome means the agent process ran to a terminal state, so any
// downstream parse failure is the work's; a turn with none means the container
// died before finishing (OOM / docker error / lost stream), which must not be
// charged to the attempt or format-retry budget. The boundary is exactly the
// errored-turn vs. truncated fixtures: both parse as unparseable verdicts, but
// only one is an infra death.
describe("passProducedResult", () => {
  it("is true for a clean run that ended in a result event", () => {
    expect(passProducedResult(fixture("verdict-approve.ndjson"))).toBe(true);
  });

  it("is true for an errored turn that still emitted a result event", () => {
    // A turn limit is the work's own doing — a terminal result arrived, so
    // this is a format-slip-shaped failure, not an infra death. It must keep
    // consuming the bounded format-retry, not re-queue freely.
    expect(passProducedResult(fixture("verdict-errored-turn.ndjson"))).toBe(true);
    expect(passProducedResult({ outcome: { kind: "turn-limit" } })).toBe(true);
    expect(passProducedResult({ outcome: { kind: "failed", reason: null } })).toBe(true);
  });

  it("is false for a stream truncated before any result event", () => {
    // The #137 shape: the container died mid-review with no result event. The
    // pass is unparseable, but as an infra death it must re-queue rather than
    // burn the format-retry.
    expect(passProducedResult(fixture("verdict-truncated.ndjson"))).toBe(false);
  });

  it("is false for empty output", () => {
    expect(passProducedResult(turnFromClaudeStream(""))).toBe(false);
  });

  it("ignores interleaved non-JSON noise while scanning for the result event", () => {
    const noisy =
      'some stderr warning that is not json\n' +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}\n' +
      '{"type":"result","subtype":"success","is_error":false,"result":"VERDICT: approve","total_cost_usd":1.2}\n';
    expect(passProducedResult(turnFromClaudeStream(noisy))).toBe(true);
  });
});
