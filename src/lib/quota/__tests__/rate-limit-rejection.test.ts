import { describe, expect, it } from "vitest";
import { parseRateLimitEvent, type QuotaObservation } from "../rate-limit-event";
import { detectQuotaRejection } from "../rate-limit-rejection";

/**
 * The one decision #168 makes about a finished turn: was this pass *refused*
 * by the account's quota, and what clock does it wait on?
 *
 * The fixture-driven half — that these are the bytes the real CLI emits at a
 * wall — lives in `orchestrator/__tests__/rate-limit-fixture.test.ts`. What is
 * pinned here is the boundary: every near-miss that must *not* pause a run,
 * because a wrong pause parks live work on a clock nobody is watching, and a
 * missed one goes back to charging the account's quota to the ticket.
 */

const OBSERVED_AT = new Date("2026-09-01T12:00:00.000Z");
const RESETS_AT_EPOCH = 1788310954;

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

describe("detectQuotaRejection — the wall", () => {
  it("reads the refusal and the window it waits on", () => {
    expect(
      detectQuotaRejection({ terminalResult: REFUSED_EXIT, rateLimit: REJECTED })
    ).toEqual({
      resumeAfter: new Date(RESETS_AT_EPOCH * 1000),
      limitType: "five_hour",
    });
  });

  it("pauses on a weekly window as readily as the five-hour one", () => {
    // Every unified window is account-wide; a run walled on the weekly limit is
    // no more the ticket's fault than one walled on the session limit.
    expect(
      detectQuotaRejection({
        terminalResult: REFUSED_EXIT,
        rateLimit: observation({
          status: "rejected",
          rateLimitType: "seven_day_opus",
          resetsAt: RESETS_AT_EPOCH,
        }),
      })
    ).toEqual({
      resumeAfter: new Date(RESETS_AT_EPOCH * 1000),
      limitType: "seven_day_opus",
    });
  });

  it("pauses on a window this build has never heard of", () => {
    // Same argument the reader makes for holding enums verbatim: a member a
    // later CLI adds must not fall back to burning an attempt.
    expect(
      detectQuotaRejection({
        terminalResult: REFUSED_EXIT,
        rateLimit: observation({
          status: "rejected",
          rateLimitType: "thirty_day_haiku",
          resetsAt: RESETS_AT_EPOCH,
        }),
      })
    ).toMatchObject({ limitType: "thirty_day_haiku" });
  });

  it("pauses on a rejection whose window the event did not name", () => {
    expect(
      detectQuotaRejection({
        terminalResult: REFUSED_EXIT,
        rateLimit: observation({ status: "rejected", resetsAt: RESETS_AT_EPOCH }),
      })
    ).toEqual({ resumeAfter: new Date(RESETS_AT_EPOCH * 1000), limitType: null });
  });

  it("still reads the wall when the CLI stops echoing the HTTP status", () => {
    // Either field is enough beside `is_error`, so a renamed or dropped field
    // does not silently take the fleet back to spending attempts on quota.
    const { api_error_status: _dropped, ...withoutStatus } = REFUSED_EXIT;
    void _dropped;
    expect(
      detectQuotaRejection({ terminalResult: withoutStatus, rateLimit: REJECTED })
    ).not.toBeNull();
  });
});

describe("detectQuotaRejection — everything that is not the wall", () => {
  it("does not pause a pass that finished, however walled the account is", () => {
    // The CLI emits an event per API attempt: a pass can see a rejection, have
    // the request retried past it, and still do its work. Pausing that run
    // would park a finished attempt on a five-hour clock.
    expect(
      detectQuotaRejection({ terminalResult: CLEAN_EXIT, rateLimit: REJECTED })
    ).toBeNull();
  });

  it("does not pause on a warning, however close to the ceiling", () => {
    expect(
      detectQuotaRejection({
        terminalResult: REFUSED_EXIT,
        rateLimit: observation({
          status: "allowed_warning",
          rateLimitType: "seven_day",
          utilization: 99,
          resetsAt: RESETS_AT_EPOCH,
        }),
      })
    ).toBeNull();
  });

  it("does not pause a rejection with no reset time to wait for", () => {
    // There would be no clock to resume from, and a run paused on an unknown
    // window is stranded where no later ticket can find it. Better to take the
    // ordinary path and spend the attempt, exactly as before this ticket.
    expect(
      detectQuotaRejection({
        terminalResult: REFUSED_EXIT,
        rateLimit: observation({ status: "rejected", rateLimitType: "five_hour" }),
      })
    ).toBeNull();
  });

  it("does not pause a pass that died without a terminal result", () => {
    // No result event means the container died mid-turn — the interruption
    // bound's business (issue #97), corroborated by nothing here.
    expect(
      detectQuotaRejection({ terminalResult: null, rateLimit: REJECTED })
    ).toBeNull();
  });

  it("does not pause a metered lane, which reports no quota at all", () => {
    // An API-key lane emits no rate_limit_event (#165, finding 6), so a 429
    // there arrives with nothing to date a resume from.
    expect(
      detectQuotaRejection({ terminalResult: REFUSED_EXIT, rateLimit: null })
    ).toBeNull();
  });

  it("does not pause an errored turn that was not an API refusal", () => {
    expect(
      detectQuotaRejection({
        terminalResult: {
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          terminal_reason: "max_turns",
        },
        rateLimit: REJECTED,
      })
    ).toBeNull();
  });
});
