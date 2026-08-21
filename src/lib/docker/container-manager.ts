import Docker from "dockerode";
import { getDocker } from "./client";
import { getImageName, ensureImage } from "./image-builder";
import { getConfig, PLATFORM_REPO_URL } from "../config";
import { getInstallationToken } from "../github/client";
import { getCapacity } from "../orchestrator/capacity";
import { AGENT_CONTAINER_NAME_PREFIX } from "./agent-containers";

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
 * The generation/ticket-loop skills every agent container installs at start
 * (issue #60). Marketplace and plugin both come from Matt Pocock's public
 * `mattpocock/skills` repo — the same source the laptop tracks at user scope,
 * so the VPS session is an extension of the laptop rather than a fork. The
 * plugin id is `<name>@<marketplace>`, where the marketplace name is `mattpocock`
 * (declared in that repo's marketplace.json), not the `owner/repo` add source.
 * Deliberately unpinned: always the latest, with the resolved version logged.
 */
export const SKILLS_MARKETPLACE_SOURCE = "mattpocock/skills";
export const SKILLS_PLUGIN_ID = "mattpocock-skills@mattpocock";

/**
 * Marker the setup script prints its resolved skills version behind, so the
 * orchestrator can lift the version out of the captured setup output and into
 * the task feed + run ledger. One constant shared by the emitter
 * (`buildSkillsInstallScript`) and the reader (`parseSkillsVersion`) so they
 * cannot drift. Contains no regex metacharacters, so it doubles as a literal
 * pattern fragment.
 */
export const SKILLS_VERSION_MARKER = "INTERLUDE_SKILLS_VERSION=";

/**
 * Bash (an `&&`-joined fragment of `buildSetupScript`) that installs the latest
 * mattpocock-skills plugin into the container's user-scoped Claude config and
 * prints its resolved version behind `SKILLS_VERSION_MARKER` (issue #60).
 *
 * Fail-fast by construction: every step is part of the setup script's single
 * `&&` chain, so a marketplace-add, clone, or install error aborts setup with a
 * non-zero exit — which `execSetup` turns into a thrown error before any agent
 * turn runs, rather than letting a generation session silently degrade to
 * freeform chat with a plugin it doesn't have. The explicit `test -n` guard
 * catches the one failure a non-zero exit would miss: an install that reports
 * success but leaves no resolvable version to log.
 */
export function buildSkillsInstallScript(): string {
  return [
    'echo "Installing mattpocock-skills plugin (latest)..."',
    `claude plugin marketplace add ${SKILLS_MARKETPLACE_SOURCE}`,
    `claude plugin install ${SKILLS_PLUGIN_ID} --scope user`,
    // No `2>/dev/null`: only stdout is piped to jq, so any CLI status on
    // stderr can't corrupt the JSON — but it stays visible in the captured
    // setup output for debugging a failed resolve.
    `SKILLS_VERSION="$(claude plugin list --json | jq -r '.[] | select(.id == "${SKILLS_PLUGIN_ID}") | .version // empty')"`,
    // A self-contained `if` (not `... || { exit 1; }`): as an `&&` operand it
    // can only fire for an empty version after the install ran, so it never
    // contaminates an earlier setup failure with a misleading skills error.
    `if [ -z "$SKILLS_VERSION" ]; then echo "ERROR: mattpocock-skills install resolved no version" >&2; exit 1; fi`,
    `echo "${SKILLS_VERSION_MARKER}$SKILLS_VERSION"`,
  ].join(" && ");
}

/**
 * Lift the mattpocock-skills version out of captured setup output (issue #60),
 * or null when the marker is absent. Takes the last marker so a version echoed
 * amid other setup chatter still resolves. The capture is restricted to
 * version characters (word chars, dot, plus, hyphen) rather than `\S+`, so a
 * stray Docker exec-frame header byte adjacent to the marker can't bleed into
 * the parsed version.
 */
export function parseSkillsVersion(setupOutput: string): string | null {
  const matches = [
    ...setupOutput.matchAll(new RegExp(`${SKILLS_VERSION_MARKER}([\\w.+-]+)`, "g")),
  ];
  return matches.length ? matches[matches.length - 1][1] : null;
}

/**
 * Bash run at container setup: install an env-based git credential helper
 * (token supplied at exec time via GIT_AUTH_TOKEN), clone the repo with a
 * secret-free URL, clone the platform repo (best-effort), get onto the task
 * branch (see `BranchCheckoutMode`), pull Doppler secrets if present, and
 * install the mattpocock-skills plugin (issue #60) — one mechanism for every
 * container kind, so a `workflow:<skill>` label always names a skill the
 * container actually has.
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
    buildSkillsInstallScript(),
  ].join(" && ");
}

/**
 * Env for a Claude turn exec. Auth is exec-scoped, mirroring GIT_AUTH_TOKEN:
 * the long-lived setup-token never lands in the container's persistent env.
 * CLAUDE_CODE_OAUTH_TOKEN is the sole subscription-auth path — the mounted
 * host credentials file it once fell back to was removed with the host
 * `~/.claude` mount (#28); ANTHROPIC_API_KEY remains an alternative.
 *
 * `ghToken` is exposed to `gh` as GH_TOKEN for generation-session execs only
 * (issue #62): it is the same short-lived App installation token as
 * GIT_AUTH_TOKEN, so there is one minting path to audit, not two, and like
 * GIT_AUTH_TOKEN it is exec-scoped and never persisted in the container. It is
 * `null` for every autonomous kind (implement/review/triage) — a token that can
 * create issues can also apply the launch-button label, so no unattended kind
 * may ever hold it; the caller decides via TurnOptions.isGenerationSession.
 */
export function buildTurnEnv(options: {
  prompt: string;
  gitAuthToken: string;
  claudeCodeOauthToken: string | null;
  ghToken: string | null;
}): string[] {
  const env = [
    `CLAUDE_PROMPT=${options.prompt}`,
    `GIT_AUTH_TOKEN=${options.gitAuthToken}`,
  ];
  if (options.claudeCodeOauthToken) {
    env.push(`CLAUDE_CODE_OAUTH_TOKEN=${options.claudeCodeOauthToken}`);
  }
  if (options.ghToken) {
    env.push(`GH_TOKEN=${options.ghToken}`);
  }
  return env;
}

/**
 * Marker the push script reports the branch's commits-ahead count behind
 * (issue #151), shared by the emitter (`buildPushScript`) and the reader
 * (`parseCommitsAhead`) so they cannot drift.
 */
export const COMMITS_AHEAD_MARKER = "INTERLUDE_COMMITS_AHEAD:";

/**
 * Bash run after each turn: commit any changes, push the branch via origin, and
 * report how far the branch is now ahead of the default branch.
 *
 * The count comes from the push rather than a GitHub round trip because it is
 * free here: the container has a full clone, so `origin/HEAD` is the default
 * branch the task branch was cut from. A branch that is level with it cannot
 * carry a PR — GitHub answers "No commits between …" with a 422 — and a session
 * that never commits (a grilling session) would otherwise re-attempt that
 * doomed call every single turn. `unknown` when git cannot count (no
 * `origin/HEAD`), which the caller treats as "attempt it anyway".
 */
export function buildPushScript(): string {
  return [
    "cd /workspace/repo",
    'git add -A && git diff --cached --quiet || git commit -m "agent: uncommitted changes"',
    "git push origin HEAD",
    `echo "${COMMITS_AHEAD_MARKER}$(git rev-list --count origin/HEAD..HEAD 2>/dev/null || echo unknown)"`,
  ].join(" && ");
}

/**
 * Lift the commits-ahead count out of captured push output, or null when it is
 * unknown (git could not count, or the marker never arrived). Takes the last
 * marker, and captures digits only, so neither earlier chatter nor a stray
 * Docker exec-frame byte can bleed into the number — the same discipline as
 * `parseSkillsVersion`.
 */
export function parseCommitsAhead(pushOutput: string): number | null {
  const matches = [
    ...pushOutput.matchAll(new RegExp(`${COMMITS_AHEAD_MARKER}(\\d+)`, "g")),
  ];
  if (!matches.length) return null;
  return parseInt(matches[matches.length - 1][1], 10);
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
  /**
   * True only for a generation-session exec — an interactive task carrying a
   * sessionSkill (issue #62). When set, the exec receives the App installation
   * token as GH_TOKEN so the generation skills can read and write issues via
   * `gh`. Never set for an autonomous implement/review/triage pass: a token
   * that can create issues can also apply the launch-button label, so no
   * unattended kind may hold it.
   */
  isGenerationSession?: boolean;
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
  const containerName = `${AGENT_CONTAINER_NAME_PREFIX}${options.taskId}-${Date.now()}`;
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
): Promise<{ skillsVersion: string | null }> {
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

  // Non-zero exit already threw above, so a successful setup always carries the
  // version marker (issue #60); parse it for the feed + run ledger.
  return { skillsVersion: parseSkillsVersion(output) };
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
      // Only a generation session's exec gets an issue-writing token (#62); the
      // same App token as GIT_AUTH_TOKEN, so one minting path, exec-scoped.
      ghToken: options.isGenerationSession ? token : null,
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

/**
 * Commit anything uncommitted, push the branch, and report how far the branch is
 * ahead of the default branch — `null` when the push output carried no readable
 * count (issue #151). Throws if the push itself failed, as before.
 */
export async function execFallbackCommitAndPush(
  running: RunningContainer
): Promise<{ commitsAhead: number | null }> {
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

  return { commitsAhead: parseCommitsAhead(output) };
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

/** Force-remove a container, idempotently — an already-gone container is not
 * an error. Shared by the handle- and name-based removers below. */
async function forceRemove(container: Docker.Container): Promise<void> {
  try {
    await container.remove({ force: true });
  } catch {
    // Already removed
  }
}

export async function removeContainer(
  running: RunningContainer
): Promise<void> {
  await forceRemove(running.container);
}

/**
 * Whether a container (by name) is still running, for the ungraceful-death
 * reaper (issue #95). Fail-safe on the side of not touching a live pass: a
 * container the daemon has definitively lost (404) or that has exited returns
 * false so its stale `running` task can be reaped; any *other* daemon error
 * (a busy or briefly unreachable socket under memory pressure) returns true —
 * assume live and let the next sweep retry, so a transient hiccup can never
 * terminalize a pass that is genuinely still working.
 */
export async function isContainerRunning(name: string): Promise<boolean> {
  try {
    const info = await getDocker().getContainer(name).inspect();
    return info.State?.Running === true;
  } catch (err) {
    return (err as { statusCode?: number })?.statusCode !== 404;
  }
}

/**
 * Whether the daemon has definitively lost a container (by name) — it answered,
 * and the answer was 404. For the queue's slot reconciliation (issue #159),
 * which needs *existence*, not liveness: an entry in `setup` has been created
 * but not started yet, and a parked pass is deliberately `docker stop`ped since
 * #93, so {@link isContainerRunning} would call both of those gone and the
 * reconciliation would free a slot out from under live work.
 *
 * Fail-safe in the same direction as its sibling, and for the same reason:
 * anything other than a definitive 404 — the container exists, or the daemon
 * errored, or it is briefly unreachable under memory pressure — returns false,
 * so an unhealthy daemon can never manufacture an absence. Only a positive
 * "no such container" counts (the #152 discipline: unknown decides nothing).
 */
export async function containerIsAbsent(name: string): Promise<boolean> {
  try {
    await getDocker().getContainer(name).inspect();
    return false;
  } catch (err) {
    return (err as { statusCode?: number })?.statusCode === 404;
  }
}

/** Force-remove a container by name — for reaping a dead pass's container
 * whose `RunningContainer` handle the orchestrator no longer holds (issue #95). */
export async function removeContainerByName(name: string): Promise<void> {
  await forceRemove(getDocker().getContainer(name));
}
