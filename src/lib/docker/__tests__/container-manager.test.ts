import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildSetupScript,
  buildSkillsInstallScript,
  parseSkillsVersion,
  buildPushScript,
  COMMITS_AHEAD_MARKER,
  parseCommitsAhead,
  createWorkspaceContainer,
  SKILLS_PLUGIN_ID,
  SKILLS_VERSION_MARKER,
} from "../container-manager";

// Capture the options passed to docker.createContainer so we can assert on the
// HostConfig the orchestrator asks Docker for.
const { createContainerSpy } = vi.hoisted(() => ({
  // Typed with an argument so the assertions below can read what the
  // orchestrator actually asked Docker for.
  createContainerSpy: vi.fn<(options: unknown) => Promise<{ id: string }>>(
    async () => ({ id: "container-under-test" })
  ),
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
    anthropicApiKey: "sk-ant-api-test",
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

  it("stops at a trailing exec-frame header byte", () => {
    // A demux frame header (non-version bytes) can abut the line; the capture
    // must not swallow it into the version.
    const output = `${SKILLS_VERSION_MARKER}1.2.3\x01\x00\x00\x00`;
    expect(parseSkillsVersion(output)).toBe("1.2.3");
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

  /**
   * How far the branch is ahead of the default branch, reported by the push
   * itself (issue #151) so the orchestrator can tell a branch that could carry
   * a PR from one that could not — with no extra round trip to GitHub.
   */
  it("reports how far the branch is ahead of the default branch", () => {
    expect(script).toContain(COMMITS_AHEAD_MARKER);
    expect(script).toContain("git rev-list --count origin/HEAD..HEAD");
  });
});

describe("parseCommitsAhead", () => {
  it("reads the count the push reported", () => {
    expect(parseCommitsAhead(`pushed\n${COMMITS_AHEAD_MARKER}3\n`)).toBe(3);
  });

  it("reads a branch level with the default branch as zero", () => {
    expect(parseCommitsAhead(`${COMMITS_AHEAD_MARKER}0`)).toBe(0);
  });

  it("takes the last count when the output carries more than one", () => {
    expect(
      parseCommitsAhead(`${COMMITS_AHEAD_MARKER}1 ... ${COMMITS_AHEAD_MARKER}2`)
    ).toBe(2);
  });

  it("is unknown when git could not count", () => {
    expect(parseCommitsAhead(`${COMMITS_AHEAD_MARKER}unknown`)).toBeNull();
  });

  it("is unknown when the marker never arrived", () => {
    expect(parseCommitsAhead("Everything up-to-date")).toBeNull();
  });
});

describe("createWorkspaceContainer", () => {
  beforeEach(() => {
    createContainerSpy.mockClear();
  });

  // Regression guard for issue #28: agent containers must not bind-mount
  // anything from the host — the old rw `~/.claude` mount is gone and must
  // stay gone. Auth reaches the container only via exec-scoped env tokens.
  const created = async () => {
    await createWorkspaceContainer({
      taskId: "01J000000000000000000TASK",
      gitUrl: "https://github.com/lennons301/interlude.git",
      branch: "agent/issue-28",
    });
    expect(createContainerSpy).toHaveBeenCalledTimes(1);
    return createContainerSpy.mock.calls[0][0] as unknown as {
      Env?: string[];
      HostConfig?: { Binds?: unknown };
    };
  };

  it("grants no host bind mount", async () => {
    const opts = await created();
    expect(opts.HostConfig?.Binds).toBeUndefined();
  });

  /**
   * Issue #172: no long-lived credential in the *persistent* container
   * environment. Lane auth is exec-scoped, so a container that outlives a turn
   * — a parked pass, an idle interactive session — holds nothing readable. The
   * mocked config deliberately supplies both an API key and a subscription
   * token; neither may appear here.
   */
  it("puts no model-provider credential in the persistent container env", async () => {
    const opts = await created();
    const env = opts.Env ?? [];
    for (const name of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "GH_TOKEN",
      "GIT_AUTH_TOKEN",
    ]) {
      expect(env.some((e) => e.startsWith(`${name}=`))).toBe(false);
    }
    expect(env.join(" ")).not.toContain("sk-ant-");
  });
});
