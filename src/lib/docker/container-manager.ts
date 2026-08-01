import Docker from "dockerode";
import { getDocker } from "./client";
import { getImageName, ensureImage } from "./image-builder";
import { getConfig, PLATFORM_REPO_URL } from "../config";
import { getInstallationToken } from "../github/client";
import { getCapacity } from "../orchestrator/capacity";

/**
 * Bash run at container setup: install an env-based git credential helper
 * (token supplied at exec time via GIT_AUTH_TOKEN), clone the repo with a
 * secret-free URL, clone the platform repo (best-effort), check out the task
 * branch, and pull Doppler secrets if a token is present.
 */
export function buildSetupScript(platformRepoUrl: string): string {
  return [
    'git config --global user.name "$GIT_USER_NAME"',
    'git config --global user.email "$GIT_USER_EMAIL"',
    `git config --global credential.helper '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GIT_AUTH_TOKEN"; }; f'`,
    'git clone "$GIT_URL" /workspace/repo',
    `git clone --depth 1 ${platformRepoUrl} /workspace/platform 2>/dev/null || echo "WARN: platform repo clone failed, continuing without platform context"`,
    "cd /workspace/repo",
    'git checkout -b "$GIT_BRANCH"',
    'if [ -n "$DOPPLER_TOKEN" ]; then curl -sf --request GET "https://api.doppler.com/v3/configs/config/secrets/download?format=env" --header "Authorization: Bearer $DOPPLER_TOKEN" > .env.local && echo "Doppler: wrote .env.local ($(wc -l < .env.local) vars)" || echo "Doppler: API request failed"; fi',
  ].join(" && ");
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
}

export interface TurnOptions {
  container: Docker.Container;
  prompt: string;
  sessionId?: string; // If set, uses --resume
}

export interface RunningContainer {
  container: Docker.Container;
  id: string;
  name: string;
  previewSubdomain: string;
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

  const binds: string[] = [];
  if (config.claudeCredentialsHostPath) {
    const hostClaudeDir = config.claudeCredentialsHostPath.replace(
      /\/.credentials\.json$/,
      ""
    );
    binds.push(`${hostClaudeDir}:/home/node/.claude:rw`);
  }

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
      Binds: binds.length > 0 ? binds : undefined,
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

  return { container, id: container.id, name: containerName, previewSubdomain };
}

export async function execSetup(
  running: RunningContainer
): Promise<void> {
  const token = await getInstallationToken();
  const exec = await running.container.exec({
    Cmd: ["bash", "-c", buildSetupScript(PLATFORM_REPO_URL)],
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

export async function execClaudeTurn(
  options: TurnOptions
): Promise<{ stream: NodeJS.ReadableStream; exec: Docker.Exec }> {
  const config = getConfig();
  const docker = getDocker();

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
    String(config.maxTurns),
    "--max-budget-usd",
    String(config.maxBudgetUsd),
  ];

  if (options.sessionId) {
    cmdParts.push("--resume", options.sessionId);
  }

  const token = await getInstallationToken();
  const exec = await options.container.exec({
    Cmd: ["bash", "-c", cmdParts.join(" ")],
    Env: [`CLAUDE_PROMPT=${options.prompt}`, `GIT_AUTH_TOKEN=${token}`],
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

export async function removeContainer(
  running: RunningContainer
): Promise<void> {
  try {
    await running.container.remove({ force: true });
  } catch {
    // Already removed
  }
}
