import Docker from "dockerode";
import { getDocker } from "./client";
import { getImageName, ensureImage } from "./image-builder";
import { getConfig } from "../config";

export interface ContainerOptions {
  taskId: string;
  gitUrl: string;
  branch: string;
  prompt: string;
}

export interface RunningContainer {
  container: Docker.Container;
  id: string;
}

export async function createAgentContainer(
  options: ContainerOptions
): Promise<RunningContainer> {
  const docker = getDocker();
  const config = getConfig();

  await ensureImage();

  // Build env vars
  const env = [
    `GIT_TOKEN=${config.gitToken}`,
    `GIT_URL=${options.gitUrl}`,
    `GIT_BRANCH=${options.branch}`,
    `GIT_USER_NAME=${config.gitUserName}`,
    `GIT_USER_EMAIL=${config.gitUserEmail}`,
    `TASK_PROMPT=${options.prompt}`,
    `MAX_TURNS=${config.maxTurns}`,
    `MAX_BUDGET_USD=${config.maxBudgetUsd}`,
    // Disable telemetry and session persistence in ephemeral containers
    "DISABLE_TELEMETRY=1",
  ];

  if (config.anthropicApiKey) {
    env.push(`ANTHROPIC_API_KEY=${config.anthropicApiKey}`);
  }

  // Build volume mounts for OAuth credentials
  // Mount the entire .claude directory so Claude Code can refresh expired tokens
  const binds: string[] = [];
  if (config.claudeCredentialsHostPath) {
    const hostClaudeDir = config.claudeCredentialsHostPath.replace(/\/.credentials\.json$/, "");
    binds.push(`${hostClaudeDir}:/home/node/.claude:rw`);
  }

  // Build the claude command with appropriate flags
  const claudeCmd = [
    'claude -p "$TASK_PROMPT"',
    "--output-format stream-json",
    "--verbose",
    "--no-session-persistence",
    "--dangerously-skip-permissions",
    '--max-turns "$MAX_TURNS"',
    '--max-budget-usd "$MAX_BUDGET_USD"',
  ].join(" ");

  const container = await docker.createContainer({
    Image: getImageName(),
    name: `interlude-task-${options.taskId}`,
    Env: env,
    Cmd: [
      "bash",
      "-c",
      [
        // Configure git
        'git config --global user.name "$GIT_USER_NAME"',
        'git config --global user.email "$GIT_USER_EMAIL"',
        // Clone repo using token
        'git clone "https://${GIT_TOKEN}@${GIT_URL#https://}" /workspace/repo',
        "cd /workspace/repo",
        // Create branch
        'git checkout -b "$GIT_BRANCH"',
        // Run Claude Code in headless mode
        claudeCmd,
        // Fallback commit if agent didn't commit its changes
        'git add -A && git diff --cached --quiet || git commit -m "agent: uncommitted changes from task"',
        // Push branch after agent completes
        'git push origin "$GIT_BRANCH"',
      ].join(" && "),
    ],
    WorkingDir: "/workspace",
    HostConfig: {
      NetworkMode: "bridge",
      Binds: binds.length > 0 ? binds : undefined,
    },
  });

  return { container, id: container.id };
}

export async function startAndAttach(
  running: RunningContainer
): Promise<NodeJS.ReadableStream> {
  const stream = await running.container.attach({
    stream: true,
    stdout: true,
    stderr: true,
  });

  await running.container.start();

  return stream;
}

export async function waitForExit(
  running: RunningContainer
): Promise<{ StatusCode: number }> {
  return running.container.wait();
}

export async function pushBranch(
  running: RunningContainer
): Promise<void> {
  const exec = await running.container.exec({
    Cmd: ["bash", "-c", "cd /workspace/repo && git push origin HEAD"],
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({});
  // Wait for push to complete
  await new Promise<void>((resolve) => {
    stream.on("end", resolve);
    stream.resume(); // drain the stream
  });
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
