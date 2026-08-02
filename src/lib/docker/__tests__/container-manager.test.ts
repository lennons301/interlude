import { describe, it, expect } from "vitest";
import {
  buildSetupScript,
  buildPushScript,
  buildTurnEnv,
} from "../container-manager";

describe("buildSetupScript", () => {
  const script = buildSetupScript("https://github.com/lennons301/platform.git");

  it("installs an env-based credential helper", () => {
    expect(script).toContain("credential.helper");
    expect(script).toContain("username=x-access-token");
    expect(script).toContain('password=$GIT_AUTH_TOKEN');
  });

  it("clones the clean repo URL with no embedded token", () => {
    expect(script).toContain('git clone "$GIT_URL" /workspace/repo');
    expect(script).not.toContain("GIT_TOKEN");
    expect(script).not.toContain("${GIT_TOKEN}@");
  });

  it("clones the platform repo and checks out the branch", () => {
    expect(script).toContain("https://github.com/lennons301/platform.git");
    expect(script).toContain('git checkout -b "$GIT_BRANCH"');
  });

  it("still writes Doppler secrets when DOPPLER_TOKEN is set", () => {
    expect(script).toContain('if [ -n "$DOPPLER_TOKEN" ]');
  });
});

describe("buildTurnEnv", () => {
  it("always carries the prompt and git auth token", () => {
    const env = buildTurnEnv({
      prompt: "do the thing",
      gitAuthToken: "ghs_abc",
      claudeCodeOauthToken: null,
    });
    expect(env).toContain("CLAUDE_PROMPT=do the thing");
    expect(env).toContain("GIT_AUTH_TOKEN=ghs_abc");
  });

  it("injects CLAUDE_CODE_OAUTH_TOKEN when configured", () => {
    const env = buildTurnEnv({
      prompt: "p",
      gitAuthToken: "t",
      claudeCodeOauthToken: "sk-ant-oat01-xyz",
    });
    expect(env).toContain("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xyz");
  });

  it("omits CLAUDE_CODE_OAUTH_TOKEN when not configured", () => {
    const env = buildTurnEnv({
      prompt: "p",
      gitAuthToken: "t",
      claudeCodeOauthToken: null,
    });
    expect(env.some((e) => e.startsWith("CLAUDE_CODE_OAUTH_TOKEN"))).toBe(false);
  });
});

describe("buildPushScript", () => {
  const script = buildPushScript();

  it("commits uncommitted changes and pushes to origin", () => {
    expect(script).toContain("git add -A");
    expect(script).toContain("git push origin HEAD");
  });

  it("does not embed any token", () => {
    expect(script).not.toContain("GIT_TOKEN");
    expect(script).not.toContain("GIT_AUTH_TOKEN");
  });
});
