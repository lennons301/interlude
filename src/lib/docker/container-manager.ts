import Docker from "dockerode";
import { getDocker } from "./client";
import { getImageName, ensureImage } from "./image-builder";
import { getConfig, PLATFORM_REPO_URL } from "../config";

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
}

export async function createWorkspaceContainer(
  options: WorkspaceOptions
): Promise<RunningContainer> {
  const docker = getDocker();
  const config = getConfig();

  await ensureImage();

  const env = [
    `GIT_TOKEN=${config.gitToken}`,
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

  const container = await docker.createContainer({
    Image: getImageName(),
    name: containerName,
    Env: env,
    Cmd: ["sleep", "infinity"],
    WorkingDir: "/workspace",
    HostConfig: {
      NetworkMode: "interlude",
      Binds: binds.length > 0 ? binds : undefined,
    },
  });

  return { container, id: container.id, name: containerName };
}

export async function execSetup(
  running: RunningContainer
): Promise<void> {
  const exec = await running.container.exec({
    Cmd: [
      "bash",
      "-c",
      [
        'git config --global user.name "$GIT_USER_NAME"',
        'git config --global user.email "$GIT_USER_EMAIL"',
        'git clone "https://${GIT_TOKEN}@${GIT_URL#https://}" /workspace/repo',
        `git clone --depth 1 ${PLATFORM_REPO_URL} /workspace/platform 2>/dev/null || echo "WARN: platform repo clone failed, continuing without platform context"`,
        "cd /workspace/repo",
        'git checkout -b "$GIT_BRANCH"',
        // If Doppler token is set, fetch secrets via API and write .env.local (no CLI needed)
        'if [ -n "$DOPPLER_TOKEN" ]; then curl -sf --request GET "https://api.doppler.com/v3/configs/config/secrets/download?format=env" --header "Authorization: Bearer $DOPPLER_TOKEN" > .env.local && echo "Doppler: wrote .env.local ($(wc -l < .env.local) vars)" || echo "Doppler: API request failed"; fi',
      ].join(" && "),
    ],
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

  const exec = await options.container.exec({
    Cmd: ["bash", "-c", cmdParts.join(" ")],
    Env: [`CLAUDE_PROMPT=${options.prompt}`],
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
  const exec = await running.container.exec({
    Cmd: [
      "bash",
      "-c",
      [
        "cd /workspace/repo",
        'git add -A && git diff --cached --quiet || git commit -m "agent: uncommitted changes"',
        "git push origin HEAD",
      ].join(" && "),
    ],
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({});

  await new Promise<void>((resolve) => {
    let resolved = false;
    let poll: ReturnType<typeof setInterval> | null = null;

    const done = () => {
      if (resolved) return;
      resolved = true;
      if (poll) clearInterval(poll);
      resolve();
    };

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
    throw new Error(`Commit and push failed with exit code ${inspectResult.ExitCode}`);
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
