import { describe, expect, it } from "vitest";
import { laneCredentialFingerprint } from "../credential-fingerprint";
import type { LaneAuthRef } from "../../lanes/lane-config";

/**
 * The primitive issue #251 fixes the quota gate with: a non-secret way to
 * tell whether a lane's credential is still the one an observation was made
 * under. Pure and deliberately boring — everything interesting about *using*
 * it lives in `quota-store.test.ts`.
 */

const ONE_TOKEN: LaneAuthRef[] = [
  { harnessVar: "CLAUDE_CODE_OAUTH_TOKEN", fromEnv: "CLAUDE_CODE_OAUTH_TOKEN" },
];

const TWO_CREDENTIALS: LaneAuthRef[] = [
  { harnessVar: "OPENAI_API_KEY", fromEnv: "CODEX_API_KEY" },
  { harnessVar: "OPENAI_BASE_URL", fromEnv: "CODEX_BASE_URL" },
];

describe("laneCredentialFingerprint", () => {
  it("is null when the lane's credential is not set", () => {
    expect(laneCredentialFingerprint(ONE_TOKEN, {})).toBeNull();
  });

  it("is null when every named variable is set but empty", () => {
    expect(
      laneCredentialFingerprint(ONE_TOKEN, { CLAUDE_CODE_OAUTH_TOKEN: "" })
    ).toBeNull();
  });

  it("is the same value for the same credential, called twice", () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-aaa" };
    expect(laneCredentialFingerprint(ONE_TOKEN, env)).toBe(
      laneCredentialFingerprint(ONE_TOKEN, env)
    );
  });

  it("changes when the credential changes — the whole point", () => {
    const before = laneCredentialFingerprint(ONE_TOKEN, {
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-old-account",
    });
    const after = laneCredentialFingerprint(ONE_TOKEN, {
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-new-account",
    });
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(before).not.toBe(after);
  });

  it("never contains the credential itself", () => {
    const secret = "sk-ant-oat01-do-not-leak-this";
    const fp = laneCredentialFingerprint(ONE_TOKEN, {
      CLAUDE_CODE_OAUTH_TOKEN: secret,
    });
    expect(fp).not.toBeNull();
    expect(fp).not.toContain(secret);
  });

  it("covers every credential a multi-variable lane needs", () => {
    const base = { CODEX_API_KEY: "key-1", CODEX_BASE_URL: "https://a.example" };
    const onlyKeyChanged = laneCredentialFingerprint(TWO_CREDENTIALS, {
      ...base,
      CODEX_API_KEY: "key-2",
    });
    const onlyUrlChanged = laneCredentialFingerprint(TWO_CREDENTIALS, {
      ...base,
      CODEX_BASE_URL: "https://b.example",
    });
    const unchanged = laneCredentialFingerprint(TWO_CREDENTIALS, base);

    expect(onlyKeyChanged).not.toBe(unchanged);
    expect(onlyUrlChanged).not.toBe(unchanged);
  });

  it("does not let a value shifting across the join boundary collide", () => {
    // Without a separator that cannot appear in a credential, ["ab", "c"] and
    // ["a", "bc"] would concatenate to the same string.
    const a = laneCredentialFingerprint(TWO_CREDENTIALS, {
      CODEX_API_KEY: "ab",
      CODEX_BASE_URL: "c",
    });
    const b = laneCredentialFingerprint(TWO_CREDENTIALS, {
      CODEX_API_KEY: "a",
      CODEX_BASE_URL: "bc",
    });
    expect(a).not.toBe(b);
  });
});
