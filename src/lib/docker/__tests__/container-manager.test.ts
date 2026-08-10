import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildSetupScript,
  buildSkillsInstallScript,
  parseSkillsVersion,
  buildPushScript,
  buildTurnEnv,
  buildClaudeTurnCommand,
  createWorkspaceContainer,
  SKILLS_PLUGIN_ID,
  SKILLS_VERSION_MARKER,
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
    maxTurns: 50,
    maxBudgetUsd: 20,
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

  it("installs the mattpocock-skills plugin as part of setup (issue #60)", () => {
    // The install runs for every container kind — one mechanism — so it lives
    // in the shared setup script rather than a per-kind branch.
    expect(script).toContain(buildSkillsInstallScript());
    expect(script).toContain("claude plugin install mattpocock-skills@mattpocock");
  });

  it("chains the skills install so a failed install aborts setup (issue #60)", () => {
    // The install fragment is joined into the single `&&` chain, and any of its
    // own steps failing (non-zero exit / empty version) aborts the chain — so a
    // failed install fails the whole setup, before any agent turn runs.
    const install = buildSkillsInstallScript();
    expect(script).toContain(` && ${install}`);
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

describe("buildSkillsInstallScript (issue #60)", () => {
  const script = buildSkillsInstallScript();

  it("adds the mattpocock marketplace and installs the plugin at user scope", () => {
    expect(script).toContain("claude plugin marketplace add mattpocock/skills");
    expect(script).toContain(`claude plugin install ${SKILLS_PLUGIN_ID} --scope user`);
  });

  it("installs the latest — no version is pinned", () => {
    // Deliberately unpinned (issue #60): the plugin id carries a marketplace,
    // never an @version, and the install passes no version flag.
    expect(script).not.toMatch(/mattpocock-skills@\d/);
  });

  it("resolves and echoes the version behind the shared marker", () => {
    expect(script).toContain("claude plugin list --json");
    expect(script).toContain(`echo "${SKILLS_VERSION_MARKER}$SKILLS_VERSION"`);
  });

  it("fails fast when the install resolves no version", () => {
    // The guard turns a silent no-op install into a hard, visible failure —
    // the exit propagates up the setup chain before any agent turn runs. A
    // self-contained `if` (not `|| { exit 1; }`) keeps its failure path scoped
    // to the skills steps, never an earlier clone/checkout failure.
    expect(script).toContain('if [ -z "$SKILLS_VERSION" ]; then');
    expect(script).toContain("exit 1");
    expect(script).not.toContain("||");
  });
});

describe("parseSkillsVersion (issue #60)", () => {
  it("lifts the version out of setup output", () => {
    const output = [
      "Cloning into '/workspace/repo'...",
      "Installing mattpocock-skills plugin (latest)...",
      `${SKILLS_VERSION_MARKER}1.2.0`,
    ].join("\n");
    expect(parseSkillsVersion(output)).toBe("1.2.0");
  });

  it("takes the last marker when several are present", () => {
    const output = `${SKILLS_VERSION_MARKER}1.0.0\nnoise\n${SKILLS_VERSION_MARKER}1.2.0`;
    expect(parseSkillsVersion(output)).toBe("1.2.0");
  });

  it("returns null when the marker is absent", () => {
    expect(parseSkillsVersion("no marker here")).toBeNull();
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

describe("buildClaudeTurnCommand", () => {
  it("runs Claude with stream-json and the configured limits", () => {
    const cmd = buildClaudeTurnCommand({});
    expect(cmd).toContain("cd /workspace/repo");
    expect(cmd).toContain("claude -p");
    expect(cmd).toContain("--output-format stream-json");
    expect(cmd).toContain("--max-turns 50");
    expect(cmd).toContain("--max-budget-usd 20");
  });

  it("prefers per-exec budget and turn overrides over the config defaults", () => {
    const cmd = buildClaudeTurnCommand({ maxTurns: 100, maxBudgetUsd: 75 });
    expect(cmd).toContain("--max-turns 100");
    expect(cmd).toContain("--max-budget-usd 75");
  });

  it("omits --model entirely when no model is pinned (issue #74)", () => {
    expect(buildClaudeTurnCommand({ model: null })).not.toContain("--model");
    expect(buildClaudeTurnCommand({})).not.toContain("--model");
  });

  it("pins the model with --model when one is resolved (issue #74)", () => {
    const cmd = buildClaudeTurnCommand({ model: "claude-sonnet-5" });
    expect(cmd).toContain("--model 'claude-sonnet-5'");
  });

  it("single-quotes the model so glob metacharacters stay literal (issue #74)", () => {
    const cmd = buildClaudeTurnCommand({ model: "claude-opus-4-8[1m]" });
    // The bracketed id must not be exposed to bash pathname expansion.
    expect(cmd).toContain("--model 'claude-opus-4-8[1m]'");
    expect(cmd).not.toContain("--model claude-opus-4-8[1m]");
  });

  it("omits --effort entirely when no level is pinned (issue #81)", () => {
    expect(buildClaudeTurnCommand({ effort: null })).not.toContain("--effort");
    expect(buildClaudeTurnCommand({})).not.toContain("--effort");
  });

  it("pins the reasoning effort with --effort when one is resolved (issue #81)", () => {
    const cmd = buildClaudeTurnCommand({ effort: "high" });
    expect(cmd).toContain("--effort 'high'");
  });

  it("carries both --model and --effort together, independently (issue #81)", () => {
    const cmd = buildClaudeTurnCommand({ model: "claude-opus-4-8", effort: "max" });
    expect(cmd).toContain("--model 'claude-opus-4-8'");
    expect(cmd).toContain("--effort 'max'");
  });

  it("appends --resume for a follow-up turn", () => {
    const cmd = buildClaudeTurnCommand({ sessionId: "sess-123" });
    expect(cmd).toContain("--resume sess-123");
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
