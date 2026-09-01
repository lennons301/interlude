import { describe, expect, it } from "vitest";
import {
  describeRateLimitType,
  parseRateLimitEvent,
  quotaSeverity,
} from "../rate-limit-event";

/**
 * The reader for the CLI's `rate_limit_event` (issue #167). The fixture-driven
 * half — that this shape is the shape the real binary emits — lives in
 * `orchestrator/__tests__/rate-limit-fixture.test.ts`, against captured bytes.
 * What is pinned here is the tolerance: every way the event can be *unlike* the
 * schema #167 documents, which the spike found several of.
 */

const OBSERVED_AT = new Date("2026-09-01T12:00:00.000Z");

function event(info: Record<string, unknown>) {
  return { type: "rate_limit_event", rate_limit_info: info, uuid: "u" };
}

describe("parseRateLimitEvent", () => {
  it("reads the full documented shape", () => {
    const observation = parseRateLimitEvent(
      event({
        status: "allowed_warning",
        resetsAt: 1790812800,
        rateLimitType: "seven_day",
        utilization: 91,
        overageStatus: "allowed",
        overageResetsAt: 1790812801,
        isUsingOverage: false,
        overageInUse: true,
      }),
      OBSERVED_AT
    );

    expect(observation).toEqual({
      status: "allowed_warning",
      rateLimitType: "seven_day",
      utilization: 91,
      resetsAt: new Date(1790812800 * 1000),
      overageStatus: "allowed",
      overageResetsAt: new Date(1790812801 * 1000),
      isUsingOverage: false,
      overageInUse: true,
      observedAt: OBSERVED_AT,
    });
  });

  it("keeps an unrecognised status and limit type rather than throwing", () => {
    // The acceptance criterion in as many words: a later CLI adding a member to
    // either enum must reach the screen, not the floor. Neither is parsed
    // against a union, which is why this cannot regress by accident.
    const observation = parseRateLimitEvent(
      event({ status: "throttled_soft", rateLimitType: "thirty_day_haiku" }),
      OBSERVED_AT
    );

    expect(observation?.status).toBe("throttled_soft");
    expect(observation?.rateLimitType).toBe("thirty_day_haiku");
    // And it is paintable: unknown is a tone, not an exception.
    expect(quotaSeverity("throttled_soft")).toBe("unknown");
    expect(describeRateLimitType("thirty_day_haiku")).toBe("thirty_day_haiku");
  });

  it("distinguishes an absent utilization from zero", () => {
    // The real-quota capture carries no `utilization` at all. Reading that as
    // 0% would describe a possibly-walled account as an idle one — the failure
    // #171's admission gate would inherit.
    const absent = parseRateLimitEvent(event({ status: "allowed" }), OBSERVED_AT);
    const zero = parseRateLimitEvent(
      event({ status: "allowed", utilization: 0 }),
      OBSERVED_AT
    );

    expect(absent?.utilization).toBeNull();
    expect(zero?.utilization).toBe(0);
  });

  it("tolerates a reset-less event, which a real warning is", () => {
    const observation = parseRateLimitEvent(
      event({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 91 }),
      OBSERVED_AT
    );
    expect(observation?.resetsAt).toBeNull();
  });

  it("treats a null or zero reset as unreported, not as 1970", () => {
    for (const resetsAt of [null, 0, -1, "soon"]) {
      const observation = parseRateLimitEvent(
        event({ status: "allowed", resetsAt }),
        OBSERVED_AT
      );
      expect(observation?.resetsAt).toBeNull();
    }
  });

  it("reads a flattened event too", () => {
    // #167 documents the fields at the top level; the wire nests them under
    // `rate_limit_info`. Both parse, so a CLI that changes its mind about which
    // is not a silent loss of the fleet's only quota signal.
    const observation = parseRateLimitEvent(
      { type: "rate_limit_event", status: "rejected", rateLimitType: "five_hour" },
      OBSERVED_AT
    );
    expect(observation).toMatchObject({ status: "rejected", rateLimitType: "five_hour" });
  });

  it("refuses anything that is not a usable rate-limit event", () => {
    for (const notAnEvent of [
      null,
      undefined,
      "rate_limit_event",
      [],
      { type: "result", subtype: "success" },
      // The right type carrying nothing to say: stored blank, it would render
      // as an observation the fleet never actually made.
      event({}),
      event({ status: 42 }),
    ]) {
      expect(parseRateLimitEvent(notAnEvent, OBSERVED_AT)).toBeNull();
    }
  });
});

describe("vocabulary", () => {
  it("names every window this build knows", () => {
    expect(describeRateLimitType("five_hour")).toBe("5-hour window");
    expect(describeRateLimitType("seven_day_opus")).toBe("weekly opus");
  });

  it("maps each known status to its own severity", () => {
    expect(quotaSeverity("allowed")).toBe("ok");
    expect(quotaSeverity("allowed_warning")).toBe("warning");
    expect(quotaSeverity("rejected")).toBe("blocked");
  });
});
