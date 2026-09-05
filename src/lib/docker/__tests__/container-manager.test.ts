import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawn } from "child_process";
import { PassThrough } from "stream";
import {
  buildSetupScript,
  buildPushScript,
  buildStopTurnScript,
  COMMITS_AHEAD_MARKER,
  parseCommitsAhead,
  createWorkspaceContainer,
  execAgentTurn,
  STOP_TURN_GRACE_SECONDS,
  STOP_TURN_TARGET_ENV,
  TURN_ID_ENV,
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
  getDocker: () => ({
    createContainer: createContainerSpy,
    // `execAgentTurn` demuxes the exec's raw stream through the modem; the
    // test below cares about what the exec was asked for, not the bytes.
    modem: { demuxStream: () => undefined },
  }),
}));
const { ensureImageSpy } = vi.hoisted(() => ({
  ensureImageSpy: vi.fn<(image: unknown) => Promise<{ skillsRef: string | null }>>(
    async () => ({ skillsRef: "v1.2.3" })
  ),
}));
vi.mock("@/lib/docker/image-builder", () => ({
  ensureImage: ensureImageSpy,
}));

/** The image a test's lane adapter declares (issue #216). */
const ADAPTER_IMAGE = { name: "interlude-agent-test:latest", dockerfile: "Dockerfile.agent-test" };
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

  it("runs no `claude plugin` command — skills are pinned into the image (issue #215)", () => {
    // Issue #60 installed the skills here, at every container start, with the
    // Claude CLI. They now arrive with the image (Dockerfile.agent-base), so setup
    // is harness-neutral and no longer spends wall-clock on a plugin install.
    // Every container kind shares this one script, so one assertion covers all.
    expect(script).not.toContain("claude plugin");
    expect(script).not.toContain("mattpocock");
    expect(script).not.toContain("SKILLS_VERSION");
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
    ensureImageSpy.mockClear();
  });

  // Regression guard for issue #28: agent containers must not bind-mount
  // anything from the host — the old rw `~/.claude` mount is gone and must
  // stay gone. Auth reaches the container only via exec-scoped env tokens.
  const created = async () => {
    await createWorkspaceContainer({
      taskId: "01J000000000000000000TASK",
      gitUrl: "https://github.com/lennons301/interlude.git",
      branch: "agent/issue-28",
      image: ADAPTER_IMAGE,
    });
    expect(createContainerSpy).toHaveBeenCalledTimes(1);
    return createContainerSpy.mock.calls[0][0] as unknown as {
      Image?: string;
      Env?: string[];
      HostConfig?: { Binds?: unknown };
    };
  };

  /**
   * Issue #216: one agent image per harness adapter. The container runs the
   * image it was handed — the resolved lane's adapter's — and that same image
   * is what is built or brought current first, so the image ensured and the
   * image run cannot be two different things.
   */
  it("ensures and runs the image the lane's adapter declares", async () => {
    const opts = await created();
    expect(opts.Image).toBe(ADAPTER_IMAGE.name);
    expect(ensureImageSpy).toHaveBeenCalledTimes(1);
    expect(ensureImageSpy).toHaveBeenCalledWith(ADAPTER_IMAGE);
  });

  it("grants no host bind mount", async () => {
    const opts = await created();
    expect(opts.HostConfig?.Binds).toBeUndefined();
  });

  /**
   * Issue #215: the skills version a pass runs with is the ref pinned into the
   * image at build, reported by `ensureImage` off the image the container is
   * created from — the container reports nothing. The turn manager writes it
   * to the feed and the run ledger, so it has to arrive on the handle.
   */
  it("carries the skills ref stamped on the image it was created from", async () => {
    const running = await createWorkspaceContainer({
      taskId: "01J000000000000000000TASK",
      gitUrl: "https://github.com/lennons301/interlude.git",
      branch: "agent/issue-215",
      image: ADAPTER_IMAGE,
    });
    expect(running.skillsRef).toBe("v1.2.3");
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

/**
 * Issue #220: the orchestrator's wall-clock ceiling needs to end one turn's
 * process tree inside a container without knowing which harness it is. The
 * exec marks its processes with a turn id in their environment, and the stop
 * script finds exactly those by it.
 */
describe("execAgentTurn", () => {
  it("marks the exec's environment with a turn id it hands back, beside the adapter's env", async () => {
    const execSpy = vi.fn<(options: unknown) => Promise<{ start: () => Promise<PassThrough> }>>(
      async () => ({ start: async () => new PassThrough() })
    );
    const { turnId } = await execAgentTurn({
      container: { exec: execSpy } as never,
      command: "fake-harness --model 'x'",
      env: ["FAKE_PROMPT=hello", "GIT_AUTH_TOKEN=ghs_x"],
    });

    expect(execSpy).toHaveBeenCalledTimes(1);
    const opts = execSpy.mock.calls[0][0] as unknown as { Env: string[]; Cmd: string[] };
    expect(opts.Cmd).toEqual(["bash", "-c", "fake-harness --model 'x'"]);
    expect(opts.Env).toEqual([
      "FAKE_PROMPT=hello",
      "GIT_AUTH_TOKEN=ghs_x",
      `${TURN_ID_ENV}=${turnId}`,
    ]);
    expect(turnId).not.toBe("");
  });
});

describe("buildStopTurnScript", () => {
  const script = buildStopTurnScript();

  it("finds the turn's processes by a whole-line match on the marker, handed the target under another name", () => {
    // The killer's own processes carry the target variable, never the marker,
    // so a whole-line match cannot find the killer itself.
    expect(script).toContain(`target="${TURN_ID_ENV}=$${STOP_TURN_TARGET_ENV}"`);
    expect(script).toContain("/proc/[0-9]*");
    expect(script).toContain('grep -qxF -- "$target"');
    expect(script).toContain('[ "$pid" = "$$" ] && continue');
  });

  it("sends TERM, waits out the grace, then KILLs what is left, and always exits 0", () => {
    const term = script.indexOf("kill -TERM");
    const grace = script.indexOf(`seq 1 ${STOP_TURN_GRACE_SECONDS}`);
    const kill = script.indexOf("kill -KILL");
    expect(term).toBeGreaterThan(-1);
    expect(grace).toBeGreaterThan(term);
    expect(kill).toBeGreaterThan(grace);
    expect(script.trimEnd().endsWith("exit 0")).toBe(true);
  });

  // The script reads `/proc`, so it can only be run where there is one. The
  // fleet's containers are Linux; a box without `/proc` pins the shape above
  // and skips the behaviour.
  it.skipIf(process.platform !== "linux")(
    "ends a process carrying the marker and leaves one that does not",
    async () => {
      const turnId = `turn-${process.pid}-${Date.now()}`;
      const marked = spawn("sleep", ["60"], {
        env: { ...process.env, [TURN_ID_ENV]: turnId },
        stdio: "ignore",
      });
      const bystander = spawn("sleep", ["60"], {
        env: { ...process.env, [TURN_ID_ENV]: `${turnId}-other` },
        stdio: "ignore",
      });
      const markedExit = new Promise<string | null>((resolve) =>
        marked.on("exit", (_code, signal) => resolve(signal))
      );

      try {
        const stop = spawn("bash", ["-c", script], {
          env: { ...process.env, [STOP_TURN_TARGET_ENV]: turnId },
          stdio: "ignore",
        });
        const stopExit = await new Promise<number | null>((resolve) =>
          stop.on("exit", (code) => resolve(code))
        );

        expect(stopExit).toBe(0);
        expect(await markedExit).toBe("SIGTERM");
        expect(bystander.exitCode).toBeNull();
        expect(bystander.signalCode).toBeNull();
      } finally {
        bystander.kill("SIGKILL");
        marked.kill("SIGKILL");
      }
    },
    20_000
  );
});
