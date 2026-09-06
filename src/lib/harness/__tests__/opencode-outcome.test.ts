import { describe, it, expect } from "vitest";
import {
  classifyOpenCodeExit,
  classifyRefusal,
  readExitCode,
  readOpenCodeError,
  OPENCODE_TURN_EXIT_EVENT,
} from "../opencode/outcome";
import { quotaRefusalOf, refusedCredential } from "../turn-result";

/**
 * The OpenCode exit classifier (issue #222): the adapter's own terminal event
 * and the last `error` event, read into the fleet's four outcomes. The error
 * shapes are the recorded ones (see `opencode-stream.test.ts` for the
 * fixtures); the statuses not recorded are synthetic on the same shape.
 */

const exit = (exitCode: unknown): Record<string, unknown> => ({
  type: OPENCODE_TURN_EXIT_EVENT,
  exitCode,
});

/** An `error` event as the CLI emits one for a provider response. */
function apiError(statusCode: number | undefined, message = "provider said no"): Record<string, unknown> {
  return {
    type: "error",
    timestamp: 1788644280000,
    sessionID: "ses_test",
    error: {
      name: "APIError",
      data: { message, ...(statusCode === undefined ? {} : { statusCode }), isRetryable: false },
    },
  };
}

const errorOf = (event: Record<string, unknown>) => readOpenCodeError(event)!;

describe("readOpenCodeError", () => {
  it("reads the name, the sentence and the status off the recorded shape", () => {
    expect(readOpenCodeError(apiError(401, "User not found."))).toEqual({
      name: "APIError",
      message: "User not found.",
      statusCode: 401,
    });
  });

  it("reads an error with no data block, and no status", () => {
    expect(
      readOpenCodeError({ type: "error", error: { name: "MessageOutputLengthError", message: "too long" } })
    ).toEqual({ name: "MessageOutputLengthError", message: "too long", statusCode: null });
  });

  it("is null for an event carrying no error object", () => {
    expect(readOpenCodeError({ type: "error" })).toBeNull();
    expect(readOpenCodeError({ type: "error", error: "boom" })).toBeNull();
  });
});

describe("readExitCode", () => {
  it("accepts a process exit code and nothing else", () => {
    expect(readExitCode(exit(0))).toBe(0);
    expect(readExitCode(exit(1))).toBe(1);
    expect(readExitCode(exit(137))).toBe(137);
    expect(readExitCode(exit(-1))).toBeNull();
    expect(readExitCode(exit(1.5))).toBeNull();
    expect(readExitCode(exit("0"))).toBeNull();
    expect(readExitCode({ type: OPENCODE_TURN_EXIT_EVENT })).toBeNull();
  });
});

describe("classifyOpenCodeExit", () => {
  it("is null when the turn script never reported — the interruption bound's case, not a failure", () => {
    expect(classifyOpenCodeExit(null, null)).toBeNull();
    // Even an error seen mid-stream is not an outcome without the exit: the
    // wrapper died, and what it would have said is unknown.
    expect(classifyOpenCodeExit(null, errorOf(apiError(429)))).toBeNull();
  });

  it("is completed on a clean exit with no error", () => {
    expect(classifyOpenCodeExit(exit(0), null)).toEqual({ kind: "completed" });
  });

  it("is failed, naming the code, on a non-zero exit with no error", () => {
    expect(classifyOpenCodeExit(exit(1), null)).toEqual({ kind: "failed", reason: "exit 1" });
    expect(classifyOpenCodeExit(exit(137), null)).toEqual({ kind: "failed", reason: "exit 137" });
    expect(classifyOpenCodeExit({ type: OPENCODE_TURN_EXIT_EVENT }, null)).toEqual({
      kind: "failed",
      reason: "no exit code",
    });
  });

  it("reads a 429 and a 402 as the account's allowance spent — a quota wall with no stated reset", () => {
    for (const status of [429, 402]) {
      const outcome = classifyOpenCodeExit(exit(1), errorOf(apiError(status)));
      expect(outcome).toEqual({
        kind: "refused",
        refusal: { kind: "quota", resumeAfter: null, limitType: null },
      });
      expect(quotaRefusalOf(outcome)).not.toBeNull();
      expect(refusedCredential(outcome)).toBe(false);
    }
  });

  it("reads a 401 and a 403 as the credential refused — a lane-availability failure, not a wall", () => {
    for (const status of [401, 403]) {
      const outcome = classifyOpenCodeExit(exit(1), errorOf(apiError(status)));
      expect(outcome).toEqual({
        kind: "refused",
        refusal: { kind: "auth", resumeAfter: null, limitType: null },
      });
      expect(refusedCredential(outcome)).toBe(true);
      expect(quotaRefusalOf(outcome)).toBeNull();
    }
  });

  it("reads any other provider status as a refusal of another kind, which takes the ordinary path", () => {
    // OpenRouter's 404 for a model that cannot run the harness's tools, and a
    // provider outage — neither is a wall and neither is the credential.
    for (const status of [404, 500, 502, 529]) {
      expect(classifyOpenCodeExit(exit(1), errorOf(apiError(status)))).toEqual({
        kind: "refused",
        refusal: { kind: "other", resumeAfter: null, limitType: null },
      });
    }
  });

  it("reads an error with no status as the CLI's own failure, named", () => {
    expect(
      classifyOpenCodeExit(exit(1), {
        name: "MessageOutputLengthError",
        message: "The model's output exceeded its length",
        statusCode: null,
      })
    ).toEqual({ kind: "failed", reason: "MessageOutputLengthError" });
    expect(
      classifyOpenCodeExit(exit(1), { name: null, message: "x".repeat(300), statusCode: null })
    ).toEqual({ kind: "failed", reason: "x".repeat(200) });
    expect(classifyOpenCodeExit(exit(1), { name: null, message: null, statusCode: null })).toEqual({
      kind: "failed",
      reason: null,
    });
  });

  it("lets the error outrank the exit code, so a refusal is never read as a clean finish or a plain failure", () => {
    expect(classifyOpenCodeExit(exit(0), errorOf(apiError(429)))).toMatchObject({ kind: "refused" });
    expect(classifyOpenCodeExit(exit(1), errorOf(apiError(429)))).toMatchObject({ kind: "refused" });
  });

  it("never yields turn-limit — the wall clock (#220) owns that on this harness", () => {
    for (const code of [0, 1, 2, 124, 137, 143]) {
      expect(classifyOpenCodeExit(exit(code), null)?.kind).not.toBe("turn-limit");
    }
  });
});

describe("classifyRefusal", () => {
  it("is null for an error carrying no status — not a provider refusal at all", () => {
    expect(classifyRefusal({ name: "UnknownError", message: "?", statusCode: null })).toBeNull();
  });
});
