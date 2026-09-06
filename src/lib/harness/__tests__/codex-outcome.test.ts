import { describe, expect, it } from "vitest";
import {
  classifyCodexExit,
  parseTryAgainAt,
  readCodexRefusal,
  readFailureMessage,
} from "../codex/outcome";

/**
 * The one place the Codex CLI's turn-ending sentence is read (issue #221):
 * `turn.completed` or `turn.failed { error: { message } }` becomes one of the
 * fleet's outcomes. The three refusal sentences are the ones the real CLI
 * (0.153.4) emitted in the recorded fixtures; the boundary cases pin what must
 * *not* read as a quota wall, since a wrong pause parks live work on a clock
 * and a missed one spends an attempt on the account's quota.
 */

/** 18:16 local on the day the fixtures were recorded. */
const NOW = new Date(2026, 8, 5, 18, 16, 0);

const RATE_LIMITED = "exceeded retry limit, last status: 429 Too Many Requests";
const USAGE_WALL =
  "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit " +
  "https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 9:16 PM.";
const BAD_KEY =
  "unexpected status 401 Unauthorized: Incorrect API key provided: sk-bogus******-key. You can find " +
  "your API key at https://platform.openai.com/account/api-keys., url: https://api.openai.com/v1/responses, " +
  "cf-ray: a366d5673e6e34ed-LHR, request id: req_06619a45f4de4f55b478f1aa7c4c6004, auth error: 401, " +
  "auth error code: invalid_api_key";
const NO_BEARER =
  "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: " +
  "https://api.openai.com/v1/responses";

const failed = (message: string) => ({ type: "turn.failed", error: { message } });

describe("classifyCodexExit", () => {
  it("is null when no turn-ending event arrived — an infra death is the interruption bound's", () => {
    expect(classifyCodexExit(null, NOW)).toBeNull();
  });

  it("reads turn.completed as a clean finish", () => {
    expect(
      classifyCodexExit(
        { type: "turn.completed", usage: { input_tokens: 4100, output_tokens: 130 } },
        NOW
      )
    ).toEqual({ kind: "completed" });
  });

  it("reads an API-key 429 as a quota refusal with no clock", () => {
    expect(classifyCodexExit(failed(RATE_LIMITED), NOW)).toEqual({
      kind: "refused",
      refusal: { kind: "quota", resumeAfter: null, limitType: null },
    });
  });

  it("reads a ChatGPT-plan usage wall as a quota refusal, with the clock time it names", () => {
    expect(classifyCodexExit(failed(USAGE_WALL), NOW)).toEqual({
      kind: "refused",
      refusal: { kind: "quota", resumeAfter: new Date(2026, 8, 5, 21, 16, 0), limitType: null },
    });
  });

  it("reads a rejected credential as an auth refusal, whichever way the API says it", () => {
    for (const message of [BAD_KEY, NO_BEARER]) {
      expect(classifyCodexExit(failed(message), NOW)).toEqual({
        kind: "refused",
        refusal: { kind: "auth", resumeAfter: null, limitType: null },
      });
    }
  });

  it("reads any other provider status as a refusal of another kind", () => {
    for (const message of [
      "unexpected status 503 Service Unavailable: upstream connect error",
      "exceeded retry limit, last status: 500 Internal Server Error",
      "server overloaded",
    ]) {
      expect(classifyCodexExit(failed(message), NOW)).toEqual({
        kind: "refused",
        refusal: { kind: "other", resumeAfter: null, limitType: null },
      });
    }
  });

  it("reads a failure naming no provider refusal as the harness's own, carrying the sentence", () => {
    expect(classifyCodexExit(failed("stream disconnected before completion: connection reset"), NOW)).toEqual({
      kind: "failed",
      reason: "stream disconnected before completion: connection reset",
    });
    expect(classifyCodexExit({ type: "turn.failed", error: {} }, NOW)).toEqual({
      kind: "failed",
      reason: null,
    });
  });

  it("bounds the reason it carries", () => {
    const outcome = classifyCodexExit(failed("x".repeat(500)), NOW);
    expect(outcome?.kind).toBe("failed");
    if (outcome?.kind === "failed") expect(outcome.reason).toHaveLength(200);
  });

  it("carries an event it does not know as a failure by name, deciding nothing on it", () => {
    expect(classifyCodexExit({ type: "turn.aborted" }, NOW)).toEqual({
      kind: "failed",
      reason: "turn.aborted",
    });
  });

  it("does not read the word 'status' or a number alone as a refusal", () => {
    // A failure sentence mentioning a count is not a provider answering with
    // one, and a quota word quoted by the agent's own tooling error is not a
    // wall either: only the provider's shapes count.
    expect(readCodexRefusal("apply_patch failed: 500 lines could not be matched", NOW)).toBeNull();
    expect(readCodexRefusal("no rollout found for thread id 1111", NOW)).toBeNull();
    expect(readCodexRefusal(null, NOW)).toBeNull();
  });

  it("reads quota ahead of a status word a quota sentence also carries", () => {
    // "last status: 429" is both a status and a wall; the wall wins.
    expect(readCodexRefusal(RATE_LIMITED, NOW)?.kind).toBe("quota");
    expect(readCodexRefusal("unexpected status 429 Too Many Requests: {\"error\":{\"code\":\"rate_limit_exceeded\"}}", NOW)?.kind).toBe("quota");
    expect(readCodexRefusal("unexpected status 429 Too Many Requests: {\"error\":{\"type\":\"insufficient_quota\"}}", NOW)?.kind).toBe("quota");
  });
});

describe("readFailureMessage", () => {
  it("reads the nested error message, falling back to a top-level one, else null", () => {
    expect(readFailureMessage(failed("boom"))).toBe("boom");
    expect(readFailureMessage({ type: "turn.failed", message: "flat" })).toBe("flat");
    expect(readFailureMessage({ type: "turn.failed", error: { message: "" } })).toBeNull();
    expect(readFailureMessage({ type: "turn.failed" })).toBeNull();
  });
});

describe("parseTryAgainAt", () => {
  it("reads the next occurrence of the named clock time in the process's local zone", () => {
    expect(parseTryAgainAt("… or try again at 9:16 PM.", NOW)).toEqual(new Date(2026, 8, 5, 21, 16, 0));
    expect(parseTryAgainAt("try again at 12:05 PM", new Date(2026, 8, 5, 9, 0, 0))).toEqual(
      new Date(2026, 8, 5, 12, 5, 0)
    );
  });

  it("rolls onto the next day when the time has already passed today, including the exact minute", () => {
    expect(parseTryAgainAt("try again at 9:16 PM", new Date(2026, 8, 5, 22, 0, 0))).toEqual(
      new Date(2026, 8, 6, 21, 16, 0)
    );
    expect(parseTryAgainAt("try again at 9:16 PM", new Date(2026, 8, 5, 21, 16, 0))).toEqual(
      new Date(2026, 8, 6, 21, 16, 0)
    );
    expect(parseTryAgainAt("try again at 12:05 AM", new Date(2026, 8, 5, 23, 0, 0))).toEqual(
      new Date(2026, 8, 6, 0, 5, 0)
    );
  });

  it("is null for a sentence naming no time, or an impossible one", () => {
    expect(parseTryAgainAt("You've hit your usage limit. Try again later.", NOW)).toBeNull();
    expect(parseTryAgainAt("try again at 13:00 PM", NOW)).toBeNull();
    expect(parseTryAgainAt("try again at 9:60 PM", NOW)).toBeNull();
    expect(parseTryAgainAt("try again at 21:16", NOW)).toBeNull();
  });
});
