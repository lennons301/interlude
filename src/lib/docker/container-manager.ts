import Docker from "dockerode";
import { getDocker } from "./client";
import { getImageName, ensureImage } from "./image-builder";
import { getConfig, PLATFORM_REPO_URL } from "../config";
import { getInstallationToken } from "../github/client";
import { getCapacity } from "../orchestrator/capacity";

/**
 * How setup gets onto `$GIT_BRANCH`:
 *  - `create`  — make a fresh branch off the default (triage/interactive use a
 *    unique per-task name that never exists on the remote).
 *  - `existing` — check out a branch that must already exist on the remote (a
 *    review or repair pass inspecting the PR branch).
 *  - `adopt` — continue the branch if a previous attempt already pushed it,
 *    else create it fresh. An autonomous retry runs in a brand-new container,
 *    so without this it would branch off the default, redo the work, and have
 *    its push rejected non-fast-forward against attempt 1's remote branch
 *    (issue #72). Adopting continues the same branch — matching the laptop
 *    runner's persistent worktree, and preserving the PR that points at it.
 */
export type BranchCheckoutMode = "create" | "existing" | "adopt";

function checkoutCommand(mode: BranchCheckoutMode): string {
  switch (mode) {
    case "existing":
      return 'git checkout "$GIT_BRANCH"';
    case "adopt":
      // `git rev-parse` resolves the remote-tracking ref that a full clone
      // fetches for every remote branch; when it exists, plain `git checkout`
      // DWIMs a local branch tracking it, otherwise branch off the default.
      return 'if git rev-parse --verify --quiet "refs/remotes/origin/$GIT_BRANCH" >/dev/null; then git checkout "$GIT_BRANCH"; else git checkout -b "$GIT_BRANCH"; fi';
    case "create":
      return 'git checkout -b "$GIT_BRANCH"';
  }
}

/**
 * Bash run at container setup: install an env-based git credential helper
 * (token supplied at exec time via GIT_AUTH_TOKEN), clone the repo with a
 * secret-free URL, clone the platform repo (best-effort), get onto the task
 * branch (see `BranchCheckoutMode`), and pull Doppler secrets if present.
 */
export function buildSetupScript(
  platformRepoUrl: string,
  checkout: BranchCheckoutMode = "create"
): string {
  return [
    'git config --global user.name "$GIT_USER_NAME"',
    'git config --global user.email "$GIT_USER_EMAIL"',
    `git config --global credential.helper '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GIT_AUTH_TOKEN"; }; f'`,
    'git clone "$GIT_URL" /workspace/repo',
    `git clone --depth 1 ${platformRepoUrl} /workspace/platform 2>/dev/null || echo "WARN: platform repo clone failed, continuing without platform context"`,
    "cd /workspace/repo",
    checkoutCommand(checkout),
    'if [ -n "$DOPPLER_TOKEN" ]; then curl -sf --request GET "https://api.doppler.com/v3/configs/config/secrets/download?format=env" --header "Authorization: Bearer $DOPPLER_TOKEN" > .env.local && echo "Doppler: wrote .env.local ($(wc -l < .env.local) vars)" || echo "Doppler: API request failed"; fi',
  ].join(" && ");
}

/**
 * Env for a Claude turn exec. Auth is exec-scoped, mirroring GIT_AUTH_TOKEN:
 * the long-lived setup-token never lands in the container's persistent env.
 * CLAUDE_CODE_OAUTH_TOKEN is the sole subscription-auth path — the mounted
 * host credentials file it once fell back to was removed with the host
 * `~/.claude` mount (#28); ANTHROPIC_API_KEY remains an alternative.
 */
export function buildTurnEnv(options: {
  prompt: string;
  gitAuthToken: string;
  claudeCodeOauthToken: string | null;
}): string[] {
  const env = [
    `CLAUDE_PROMPT=${options.prompt}`,
    `GIT_AUTH_TOKEN=${options.gitAuthToken}`,
  ];
  if (options.claudeCodeOauthToken) {
    env.push(`CLAUDE_CODE_OAUTH_TOKEN=${options.claudeCodeOauthToken}`);
  }
  return env;
}

/** Bash run after each turn: commit any changes and push the branch via origin. */
export function buildPushScript(): string {
  return [
    "cd /workspace/repo",
    'git add -A && git diff --cached --quiet || git commit -m "agent: uncommitted changes"',
    "git push origin HEAD",
  ].join(" && ");
}

export interface WorkspaceOptions {
  taskId: string;
  gitUrl: string;
  branch: string;
  dopplerToken?: string;
  /** How setup gets onto the branch (default `create`) — see `BranchCheckoutMode` */
  checkout?: BranchCheckoutMode;
}

export interface TurnOptions {
  container: Docker.Container;
  prompt: string;
  sessionId?: string; // If set, uses --resume
  /** Per-exec budget override (autonomous runs carry their attempt budget) */
  maxBudgetUsd?: number;
  /** Per-exec turn-limit override (a ticket's max-turns directive) */
  maxTurns?: number;
  /**
   * Model to pin for this turn, resolved from the task's kind (issue #74).
   * Null/undefined passes no `--model` — the CLI resolves the account default.
   */
  model?: string | null;
  /**
   * Reasoning-effort level for this turn, resolved from the task's kind
   * (issue #81). Null/undefined passes no `--effort` — the CLI resolves its
   * own default.
   */
  effort?: string | null;
}

export interface RunningContainer {
  container: Docker.Container;
  id: string;
  name: string;
  previewSubdomain: string;
  /** How setup gets onto the branch (default `create`) — see `BranchCheckoutMode` */
  checkout?: BranchCheckoutMode;
}

export async function createWorkspaceContainer(
  options: WorkspaceOptions
): Promise<RunningContainer> {
  const docker = getDocker();
  const config = getConfig();

  await ensureImage();

  const env = [
    `GIT_URL=${options.gitUrl}`,
    `GIT_BRANCH=${options.branch}`,
    `GIT_USER_NAME=${config.gitUserName}`,
    `GIT_USER_EMAIL=${config.gitUserEmail}`,
    "DISABLE_TELEMETRY=1",
  ];

  if (config.anthropicApiKey) {
    env.push(`ANTHROPIC_API_KEY=${config.anthropicApiKey}`);
  }

  if (options.dopplerToken) {
    env.push(`DOPPLER_TOKEN=${options.dopplerToken}`);
  }

  // What an agent container is granted from the host — deliberately, and
  // nothing else (issue #28):
  //   - the `interlude` Docker network (for preview routing), and
  //   - a fresh, short-lived GitHub App token per exec (GIT_AUTH_TOKEN).
  // Claude auth arrives the same exec-scoped way, as CLAUDE_CODE_OAUTH_TOKEN
  // in buildTurnEnv — it is the VPS-verified live path (#48). There is NO
  // bind mount: the container never sees the host's `~/.claude`, so it cannot
  // read or write the host user's Claude config, history, project state or
  // credentials, and whatever the image installs under /home/node/.claude
  // (e.g. plugins) is no longer shadowed at runtime. Before adding any Bind
  // here, weigh it against that: a mount is host reach that outlives the run.
  const containerName = `interlude-task-${options.taskId}-${Date.now()}`;
  // DNS-safe subdomain derived from task ID (last 8 chars of ULID, lowercased)
  const previewSubdomain = `task-${options.taskId.slice(-8).toLowerCase()}`;

  const capacity = await getCapacity();

  const container = await docker.createContainer({
    Image: getImageName(),
    name: containerName,
    Env: env,
    Cmd: ["sleep", "infinity"],
    WorkingDir: "/workspace",
    HostConfig: {
      NetworkMode: "interlude",
      // Hard caps: a runaway agent fails its own task, never the platform.
      // MemorySwap = Memory disables swap, so the cap bites immediately.
      Memory: capacity.perAgentMemory,
      MemorySwap: capacity.perAgentMemory,
      NanoCpus: capacity.cpuQuota,
    },
    NetworkingConfig: {
      EndpointsConfig: {
        interlude: {
          Aliases: [previewSubdomain],
        },
      },
    },
  });

  return {
    container,
    id: container.id,
    name: containerName,
    previewSubdomain,
    checkout: options.checkout,
  };
}

export async function execSetup(
  running: RunningContainer
): Promise<void> {
  const token = await getInstallationToken();
  const exec = await running.container.exec({
    Cmd: ["bash", "-c", buildSetupScript(PLATFORM_REPO_URL, running.checkout ?? "create")],
    Env: [`GIT_AUTH_TOKEN=${token}`],
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({});
  const outputChunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    let resolved = false;
    let poll: ReturnType<typeof setInterval> | null = null;

    const done = () => {
      if (resolved) return;
      resolved = true;
      if (poll) clearInterval(poll);
      resolve();
    };

    stream.on("data", (chunk: Buffer) => outputChunks.push(chunk));
    stream.on("end", done);
    stream.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      if (poll) clearInterval(poll);
      reject(err);
    });

    poll = setInterval(async () => {
      try {
        const info = await exec.inspect();
        if (!info.Running) {
          setTimeout(done, 500);
        }
      } catch {
        done();
      }
    }, 2000);
  });

  const output = Buffer.concat(outputChunks).toString().trim();
  if (output) {
    console.log(`[setup] ${output}`);
  }

  const inspectResult = await exec.inspect();
  if (inspectResult.ExitCode !== 0) {
    throw new Error(`Workspace setup failed with exit code ${inspectResult.ExitCode}: ${output.slice(-500)}`);
  }
}

/**
 * Build the bash command a Claude turn runs inside the container. Pure and
 * exported so the flag wiring — notably the per-kind `--model` pin (issue #74)
 * and `--effort` level (issue #81) — is unit-testable without a live Docker
 * exec. `maxTurns`/`maxBudgetUsd` fall back to the configured defaults;
 * `model` and `effort`, when set, pin the tier and reasoning depth and are
 * otherwise omitted so the CLI resolves its own defaults as before.
 */
export function buildClaudeTurnCommand(
  options: Pick<
    TurnOptions,
    "sessionId" | "maxBudgetUsd" | "maxTurns" | "model" | "effort"
  >
): string {
  const config = getConfig();

  const cmdParts = [
    "cd /workspace/repo",
    "&&",
    "claude",
    "-p",
    '"$CLAUDE_PROMPT"',
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--max-turns",
    String(options.maxTurns ?? config.maxTurns),
    "--max-budget-usd",
    String(options.maxBudgetUsd ?? config.maxBudgetUsd),
  ];

  if (options.model) {
    // Single-quote the model id: real ids can carry shell glob metacharacters
    // (e.g. "claude-opus-4-8[1m]"), and this runs under `bash -c`.
    cmdParts.push("--model", `'${options.model}'`);
  }

  if (options.effort) {
    // The value is always one of the CLI's bounded levels — both entry points
    // validate against the same allowlist (the ticket directive clamps, the
    // env is checked in config.ts), so no metacharacter can reach here. Still
    // single-quoted for the same defence-in-depth reason as the model above,
    // since this runs under `bash -c`.
    cmdParts.push("--effort", `'${options.effort}'`);
  }

  if (options.sessionId) {
    cmdParts.push("--resume", options.sessionId);
  }

  return cmdParts.join(" ");
}

export async function execClaudeTurn(
  options: TurnOptions
): Promise<{ stream: NodeJS.ReadableStream; exec: Docker.Exec }> {
  const docker = getDocker();
  const config = getConfig();

  const token = await getInstallationToken();
  const exec = await options.container.exec({
    Cmd: ["bash", "-c", buildClaudeTurnCommand(options)],
    Env: buildTurnEnv({
      prompt: options.prompt,
      gitAuthToken: token,
      claudeCodeOauthToken: config.claudeCodeOauthToken,
    }),
    AttachStdout: true,
    AttachStderr: true,
  });

  const rawStream = await exec.start({});

  // Demux the Docker multiplexed stream
  const { PassThrough } = await import("stream");
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(rawStream, stdout, stderr);

  // Merge stderr into stdout (Claude writes to both)
  const merged = new PassThrough();
  stdout.pipe(merged, { end: false });
  stderr.pipe(merged, { end: false });

  let endCount = 0;
  const onEnd = () => {
    endCount++;
    if (endCount >= 2) merged.end();
  };
  stdout.on("end", onEnd);
  stderr.on("end", onEnd);

  return { stream: merged, exec };
}

export async function execFallbackCommitAndPush(
  running: RunningContainer
): Promise<void> {
  const token = await getInstallationToken();
  const exec = await running.container.exec({
    Cmd: ["bash", "-c", buildPushScript()],
    Env: [`GIT_AUTH_TOKEN=${token}`],
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({});
  let output = "";

  await new Promise<void>((resolve) => {
    let resolved = false;
    let poll: ReturnType<typeof setInterval> | null = null;

    const done = () => {
      if (resolved) return;
      resolved = true;
      if (poll) clearInterval(poll);
      resolve();
    };

    stream.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    stream.on("end", done);
    stream.resume();

    poll = setInterval(async () => {
      try {
        const info = await exec.inspect();
        if (!info.Running) {
          setTimeout(done, 500);
        }
      } catch {
        done();
      }
    }, 2000);
  });

  const inspectResult = await exec.inspect();
  if (inspectResult.ExitCode !== 0) {
    const detail = output.replace(/[^ -~]+/g, " ").trim().slice(-800);
    throw new Error(
      `Commit and push failed (exit ${inspectResult.ExitCode})${detail ? ": " + detail : ""}`
    );
  }
}

export async function stopContainer(
  running: RunningContainer
): Promise<void> {
  try {
    await running.container.stop({ t: 5 });
  } catch {
    // Already stopped
  }
}

/**
 * Start (or resume) a container's Docker process. Idempotent: the daemon
 * answers an already-running container with a 304, which is not an error we
 * care about — a genuine start failure (bad image, missing container) still
 * propagates so the caller's turn fails loudly rather than execing into a dead
 * container. Used to resume a container `stopContainer` parked to free memory
 * (issue #93).
 */
export async function startContainer(
  running: RunningContainer
): Promise<void> {
  try {
    await running.container.start();
  } catch (err) {
    if ((err as { statusCode?: number })?.statusCode === 304) return; // Already running
    throw err;
  }
}

export async function removeContainer(
  running: RunningContainer
): Promise<void> {
  try {
    await running.container.remove({ force: true });
  } catch {
    // Already removed
  }
}
