import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { finalPassMessage, passProducedResult } from "../pass-output";

// Fixtures follow the shape of __tests__/stream-fixture.ndjson: the raw
// stream-json a pass emits, ending (when it finishes cleanly) in a `result`
// event whose `result` field is the turn's final message.
function fixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
}

describe("finalPassMessage", () => {
  it("extracts the final message from a clean result event", () => {
    expect(finalPassMessage(fixture("verdict-approve.ndjson"))).toMatchObject({
      ok: true,
    });
  });

  it("fails on a stream that never reached a result event", () => {
    expect(finalPassMessage(fixture("verdict-truncated.ndjson"))).toMatchObject({
      ok: false,
    });
  });
});

// The classifier the interruption-vs-failure split hangs on (issue #97): a
// stream with a terminal `result` event means the agent process ran to a
// terminal state, so any downstream parse failure is the work's; a stream
// with none means the container died before finishing (OOM / docker error /
// lost stream), which must not be charged to the attempt or format-retry
// budget. The boundary is exactly the errored-turn vs. truncated fixtures:
// both parse as unparseable verdicts, but only one is an infra death.
describe("passProducedResult", () => {
  it("is true for a clean run that ended in a result event", () => {
    expect(passProducedResult(fixture("verdict-approve.ndjson"))).toBe(true);
  });

  it("is true for an errored turn that still emitted a result event", () => {
    // error_max_turns is the work's own doing — a terminal result arrived, so
    // this is a format-slip-shaped failure, not an infra death. It must keep
    // consuming the bounded format-retry, not re-queue freely.
    expect(passProducedResult(fixture("verdict-errored-turn.ndjson"))).toBe(true);
  });

  it("is false for a stream truncated before any result event", () => {
    // The #137 shape: the container died mid-review with no result event. The
    // pass is unparseable, but as an infra death it must re-queue rather than
    // burn the format-retry.
    expect(passProducedResult(fixture("verdict-truncated.ndjson"))).toBe(false);
  });

  it("is false for empty output", () => {
    expect(passProducedResult("")).toBe(false);
  });

  it("ignores interleaved non-JSON noise while scanning for the result event", () => {
    const noisy =
      'some stderr warning that is not json\n' +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}\n' +
      '{"type":"result","subtype":"success","is_error":false,"result":"VERDICT: approve","total_cost_usd":1.2}\n';
    expect(passProducedResult(noisy)).toBe(true);
  });
});
