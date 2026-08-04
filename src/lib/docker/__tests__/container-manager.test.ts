import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildSetupScript,
  buildPushScript,
  buildTurnEnv,
  createWorkspaceContainer,
} from "../container-manager";

// Capture the options passed to docker.createContainer so we can assert on the
// HostConfig the orchestrator asks Docker for.
const { createContainerSpy } = vi.hoisted(() => ({
  createContainerSpy: vi.fn(async () => ({ id: "container-under-test" })),
}));

vi.mock("@/lib/docker/client", () => ({
  getDocker: () => ({ createContainer: createContainerSpy }),
}));
vi.mock("@/lib/docker/image-builder", () => ({
  ensureImage: vi.fn(async () => {}),
  getImageName: () => "interlude-agent:test",
}));
vi.mock("@/lib/orchestrator/capacity", () => ({
  getCapacity: vi.fn(async () => ({
    slots: 2,
    perAgentMemory: 1200 * 1024 * 1024,
    cpuQuota: 1_000_000_000,
  })),
}));
vi.mock("@/lib/github/client", () => ({
  getInstallationToken: vi.fn(async () => "ghs_installation"),
}));
vi.mock("@/lib/config", () => ({
  PLATFORM_REPO_URL: "https://github.com/lennons301/platform.git",
  getConfig: () => ({
    anthropicApiKey: null,
    claudeCodeOauthToken: "sk-ant-oat01-test",
    gitUserName: "Interlude Agent",
    gitUserEmail: "agent@interlude.dev",
  }),
}));

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

  it("creates a fresh branch by default", () => {
    expect(script).toContain('git checkout -b "$GIT_BRANCH"');
    expect(script).not.toContain("rev-parse");
  });

  it("checks out the existing remote branch for a review pass", () => {
    const reviewScript = buildSetupScript(
      "https://github.com/lennons301/platform.git",
      "existing"
    );
    expect(reviewScript).toContain('git checkout "$GIT_BRANCH"');
    expect(reviewScript).not.toContain("git checkout -b");
  });

  it("adopts an existing agent/issue branch on retry, else creates it (issue #72)", () => {
    const adoptScript = buildSetupScript(
      "https://github.com/lennons301/platform.git",
      "adopt"
    );
    // Continue a previous attempt's remote branch when it exists...
    expect(adoptScript).toContain(
      'git rev-parse --verify --quiet "refs/remotes/origin/$GIT_BRANCH"'
    );
    expect(adoptScript).toContain('git checkout "$GIT_BRANCH"');
    // ...otherwise branch fresh (first attempt).
    expect(adoptScript).toContain('git checkout -b "$GIT_BRANCH"');
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

describe("createWorkspaceContainer", () => {
  beforeEach(() => {
    createContainerSpy.mockClear();
  });

  // Regression guard for issue #28: agent containers must not bind-mount
  // anything from the host — the old rw `~/.claude` mount is gone and must
  // stay gone. Auth reaches the container only via exec-scoped env tokens.
  it("grants no host bind mount", async () => {
    await createWorkspaceContainer({
      taskId: "01J000000000000000000TASK",
      gitUrl: "https://github.com/lennons301/interlude.git",
      branch: "agent/issue-28",
    });

    expect(createContainerSpy).toHaveBeenCalledTimes(1);
    const opts = createContainerSpy.mock.calls[0][0] as {
      HostConfig?: { Binds?: unknown };
    };
    expect(opts.HostConfig?.Binds).toBeUndefined();
  });
});
