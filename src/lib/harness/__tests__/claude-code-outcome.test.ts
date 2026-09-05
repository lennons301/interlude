import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  parseRateLimitEvent,
  type QuotaObservation,
} from "@/lib/quota/rate-limit-event";
import { classifyClaudeExit, readFinalMessage } from "../claude-code/outcome";

/**
 * The one place the Claude Code CLI's exit vocabulary is read (issue #214):
 * a terminal `result` event, with the turn's last quota observation beside it,
 * becomes one of the fleet's four outcomes.
 *
 * The fixture-driven half — that these are the bytes the real CLI emits at a
 * wall — lives in `claude-code-rate-limit-fixture.test.ts`. What is pinned
 * here is the boundary: every near-miss that must *not* read as a quota
 * refusal, because a wrong pause parks live work on a clock nobody is
 * watching, and a missed one goes back to charging the account's quota to the
 * ticket; and the mapping of every other exit, which the turn manager and the
 * reducer used to read for themselves.
 */

const OBSERVED_AT = new Date("2026-09-01T12:00:00.000Z");
const RESETS_AT_EPOCH = 1788310954;
const RESETS_AT = new Date(RESETS_AT_EPOCH * 1000);

function observation(info: Record<string, unknown>): QuotaObservation {
  const parsed = parseRateLimitEvent(
    { type: "rate_limit_event", rate_limit_info: info },
    OBSERVED_AT
  );
  if (!parsed) throw new Error("fixture is not a readable rate_limit_event");
  return parsed;
}

/** The rejection the captured stream carries. */
const REJECTED = observation({
  status: "rejected",
  resetsAt: RESETS_AT_EPOCH,
  rateLimitType: "five_hour",
  isUsingOverage: false,
});

/** The exit condition the CLI reports at a wall — note `subtype: "success"`,
 * which is why the exit alone cannot be the signal (issue #165's finding). */
const REFUSED_EXIT = {
  type: "result",
  subtype: "success",
  is_error: true,
  terminal_reason: "api_error",
  api_error_status: 429,
  total_cost_usd: 0,
};

/** A clean finish, for the same reason: it is `subtype: "success"` too. */
const CLEAN_EXIT = {
  type: "result",
  subtype: "success",
  is_error: false,
  terminal_reason: "completed",
  api_error_status: null,
  total_cost_usd: 1.23,
};

const quotaRefusal = (resumeAfter: Date | null, limitType: string | null) => ({
  kind: "refused",
  refusal: { kind: "quota", resumeAfter, limitType },
});

describe("classifyClaudeExit — the wall", () => {
  it("reads the refusal and the window it waits on", () => {
    expect(classifyClaudeExit(REFUSED_EXIT, REJECTED)).toEqual(
      quotaRefusal(RESETS_AT, "five_hour")
    );
  });

  it("reads a tier-scoped weekly window as readily as the five-hour one", () => {
    // The window is reported verbatim and judged nowhere here: what a
    // tier-scoped one *means* — step down the ladder rather than pause (issue
    // #170) — is the reducer's decision, and this module's job is only to say
    // that the account refused the pass and on which window.
    expect(
      classifyClaudeExit(
        REFUSED_EXIT,
        observation({
          status: "rejected",
          rateLimitType: "seven_day_opus",
          resetsAt: RESETS_AT_EPOCH,
        })
      )
    ).toEqual(quotaRefusal(RESETS_AT, "seven_day_opus"));
  });

  it("refuses on a window this build has never heard of", () => {
    // Same argument the reader makes for holding enums verbatim: a member a
    // later CLI adds must not fall back to burning an attempt.
    expect(
      classifyClaudeExit(
        REFUSED_EXIT,
        observation({
          status: "rejected",
          rateLimitType: "thirty_day_haiku",
          resetsAt: RESETS_AT_EPOCH,
        })
      )
    ).toEqual(quotaRefusal(RESETS_AT, "thirty_day_haiku"));
  });

  it("refuses on a rejection whose window the event did not name", () => {
    expect(
      classifyClaudeExit(
        REFUSED_EXIT,
        observation({ status: "rejected", resetsAt: RESETS_AT_EPOCH })
      )
    ).toEqual(quotaRefusal(RESETS_AT, null));
  });

  it("reports a rejection that named no reset time, rather than hiding it", () => {
    // Withheld until #170, when pausing was a wall's only possible consequence
    // and a run parked on an invented clock would have been stranded. A
    // tier-scoped wall now degrades and retries, which waits on no clock, so
    // both facts go to the reducer and it declines the pause itself.
    expect(
      classifyClaudeExit(
        REFUSED_EXIT,
        observation({ status: "rejected", rateLimitType: "five_hour" })
      )
    ).toEqual(quotaRefusal(null, "five_hour"));
  });

  it("still reads the wall when the CLI stops echoing the HTTP status", () => {
    // Either field is enough beside `is_error`, so a renamed or dropped field
    // does not silently take the fleet back to spending attempts on quota.
    const { api_error_status: _dropped, ...withoutStatus } = REFUSED_EXIT;
    void _dropped;
    expect(classifyClaudeExit(withoutStatus, REJECTED)).toEqual(
      quotaRefusal(RESETS_AT, "five_hour")
    );
  });
});

describe("classifyClaudeExit — everything that is not the wall", () => {
  it("completes a pass that finished, however walled the account is", () => {
    // The CLI emits an event per API attempt: a pass can see a rejection, have
    // the request retried past it, and still do its work. Pausing that run
    // would park a finished attempt on a five-hour clock.
    expect(classifyClaudeExit(CLEAN_EXIT, REJECTED)).toEqual({ kind: "completed" });
  });

  it("does not refuse on a warning, however close to the ceiling", () => {
    expect(
      classifyClaudeExit(
        REFUSED_EXIT,
        observation({
          status: "allowed_warning",
          rateLimitType: "seven_day",
          utilization: 99,
          resetsAt: RESETS_AT_EPOCH,
        })
      )
    ).toEqual({
      kind: "refused",
      refusal: { kind: "other", resumeAfter: null, limitType: null },
    });
  });

  it("reports no outcome for a pass that died without a terminal result", () => {
    // No result event means the container died mid-turn — the interruption
    // bound's business (issue #97), corroborated by nothing here. Null rather
    // than `failed`, because a failure is the work's and this is the box's.
    expect(classifyClaudeExit(null, REJECTED)).toBeNull();
  });

  it("reads a 429 on a lane that reports no quota as a refusal of another kind", () => {
    // An API-key lane emits no rate_limit_event (#165, finding 6), so a 429
    // there arrives with nothing to date a resume from — and, crucially,
    // nothing corroborating that it was the account's quota. Not a wall; the
    // ordinary path, exactly as before.
    expect(classifyClaudeExit(REFUSED_EXIT, null)).toEqual({
      kind: "refused",
      refusal: { kind: "other", resumeAfter: null, limitType: null },
    });
  });

  it("reads a rejected credential as an auth refusal", () => {
    for (const status of [401, 403]) {
      expect(
        classifyClaudeExit({ ...REFUSED_EXIT, api_error_status: status }, null)
      ).toEqual({
        kind: "refused",
        refusal: { kind: "auth", resumeAfter: null, limitType: null },
      });
    }
  });

  it("reads an error the CLI does not attribute to the API as failed, not refused", () => {
    // The one predicate for "the API refused the turn" is the pre-#214 one:
    // `is_error` beside a 429 or an `api_error` reason. An error carrying
    // neither — whatever status it echoes — is the harness's own, and takes
    // the path it always took.
    expect(
      classifyClaudeExit(
        { ...REFUSED_EXIT, terminal_reason: "unknown", api_error_status: 401 },
        REJECTED
      )
    ).toEqual({ kind: "failed", reason: "success" });
  });

  it("reads the CLI's turn ceiling as the turn limit, whatever else the exit says", () => {
    // Judged ahead of the wall, as the turn manager always judged exhaustion
    // ahead of the pause: a pass at both bounds at once fails its attempt.
    expect(
      classifyClaudeExit(
        {
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          terminal_reason: "max_turns",
        },
        REJECTED
      )
    ).toEqual({ kind: "turn-limit" });
  });

  it("reads any other terminal error as failed, naming the CLI's word for it", () => {
    expect(
      classifyClaudeExit(
        { type: "result", subtype: "error_during_execution", is_error: true },
        null
      )
    ).toEqual({ kind: "failed", reason: "error_during_execution" });
  });

  it("reads a subtype it has never met as failed rather than completed", () => {
    // A later CLI's new terminal state is an error the harness owned up to,
    // not a finish: reading it as completed would let a review parse a verdict
    // out of a turn that did not end.
    expect(
      classifyClaudeExit({ type: "result", subtype: "error_max_budget_usd" }, null)
    ).toEqual({ kind: "failed", reason: "error_max_budget_usd" });
  });
});

describe("readFinalMessage — the one rule for a turn's final message", () => {
  it("prefers the result event's own statement, falling back to the last text block", () => {
    expect(readFinalMessage({ result: "VERDICT: approve" }, "earlier text")).toBe(
      "VERDICT: approve"
    );
    expect(readFinalMessage({ result: "   " }, "earlier text")).toBe("earlier text");
    expect(readFinalMessage({ result: 42 }, "earlier text")).toBe("earlier text");
    expect(readFinalMessage({}, null)).toBeNull();
    expect(readFinalMessage(null, "earlier text")).toBe("earlier text");
  });

  it("changes nothing observed: on every captured stream the two readings were one", () => {
    // Before #214 the exit readers read the result event's `result` string
    // and the blocked-marker detector read the last assistant text block. The
    // unified rule rests on their being the same bytes on every real stream
    // the fleet has captured — which this pins, so a capture that breaks it
    // fails here rather than moving a decision silently.
    const captures = [
      "stream-fixture.ndjson",
      "rate-limit-allowed-fixture.ndjson",
      "rate-limit-rejected-fixture.ndjson",
    ];
    for (const name of captures) {
      const lines = fs
        .readFileSync(path.join(__dirname, name), "utf-8")
        .split("\n")
        .filter((l) => l.trim());
      let terminal: Record<string, unknown> | null = null;
      let lastText: string | null = null;
      for (const line of lines) {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === "result") terminal = event;
        if (event.type === "assistant") {
          const message = event.message as { content?: Array<{ type?: string; text?: string }> };
          for (const block of message.content ?? []) {
            if (block.type === "text" && block.text) lastText = block.text;
          }
        }
      }
      expect(terminal, name).not.toBeNull();
      expect(lastText, name).not.toBeNull();
      expect(terminal!.result, name).toBe(lastText);
      expect(readFinalMessage(terminal, lastText), name).toBe(lastText);
    }
  });
});
