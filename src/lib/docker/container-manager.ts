import Docker from "dockerode";
import { getDocker } from "./client";
import { getImageName, ensureImage } from "./image-builder";
import { getConfig, PLATFORM_REPO_URL } from "../config";
import { getInstallationToken } from "../github/client";
import { getCapacity } from "../orchestrator/capacity";
import {
  AGENT_CONTAINER_NAME_PREFIX,
  DOCKER_PROBE_TIMEOUT_MS,
} from "./agent-containers";
import { runBoundedProbe } from "../timeout";

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
 * How a Claude turn's exec environment and command are built moved to the
 * harness adapter with issue #172 — see `src/lib/harness/claude-code.ts`. This
 * module owns the Docker mechanics (create, setup, exec, push, reap) and is
 * deliberately harness-agnostic now: `execAgentTurn` below runs whatever
 * command the adapter produced, with whatever environment the resolved lane
 * supplied.
 */

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

  // Deliberately no model-provider credential here (issue #172). Lane auth —
  // whichever variables the resolved lane names — reaches the harness only in
  // an exec's environment, so no long-lived credential sits in the persistent
  // container environment where a parked or idle container would keep it
  // readable. ANTHROPIC_API_KEY used to be set here and is not any more; the
  // `anthropic-api` lane supplies it per exec instead.
  if (options.dopplerToken) {
    env.push(`DOPPLER_TOKEN=${options.dopplerToken}`);
  }

  // What an agent container is granted from the host — deliberately, and
  // nothing else (issue #28):
  //   - the `interlude` Docker network (for preview routing), and
  //   - a fresh, short-lived GitHub App token per exec (GIT_AUTH_TOKEN).
  // Model-provider auth arrives the same exec-scoped way, as whichever
  // variables the resolved execution lane names (issue #172) — for the default
  // subscription lane that is CLAUDE_CODE_OAUTH_TOKEN, the VPS-verified live
  // path (#48) — built by the harness adapter. There is NO
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
 * Run one agent turn: exec the harness's command with the harness's
 * environment, and hand back the demuxed output stream.
 *
 * Both come from the adapter the resolved lane names (issue #172), so this
 * function knows nothing about which harness, which provider or which
 * credential is in play — it is the Docker half of a turn and nothing else.
 * The environment it is handed is exec-scoped by construction: it goes into
 * this one exec and is never written to the container.
 */
export async function execAgentTurn(options: {
  container: Docker.Container;
  /** The command the harness adapter built. */
  command: string;
  /** The environment the harness adapter built from the resolved lane. */
  env: string[];
}): Promise<{ stream: NodeJS.ReadableStream; exec: Docker.Exec }> {
  const docker = getDocker();

  const exec = await options.container.exec({
    Cmd: ["bash", "-c", options.command],
    Env: options.env,
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
 * Wait for an exec to finish and report its exit code.
 *
 * Both signals, for the reason every exec in this file uses both: the stream
 * ending is the fast path, and the poll is what covers a stream that never
 * ends (which is the normal case for a demuxed or hijacked attach — the socket
 * outlives the process). Bounded by neither, deliberately: these execs are a
 * `cat` of one file, and the container itself is the bound.
 */
async function awaitExecExit(
  exec: Docker.Exec,
  stream: NodeJS.ReadableStream
): Promise<number | null> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    const done = () => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      resolve();
    };
    stream.on("end", done);
    stream.on("close", done);
    stream.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      reject(err);
    });
    poll = setInterval(async () => {
      try {
        const info = await exec.inspect();
        if (!info.Running) setTimeout(done, 200);
      } catch {
        done();
      }
    }, 250);
    // Nothing may sit unread: a paused stream never ends, and a caller that
    // does not want the output (the write below) would otherwise wait out the
    // poll on every call.
    stream.resume();
  });

  return (await exec.inspect()).ExitCode ?? null;
}

/**
 * Read one file out of a container, verbatim (issue #169).
 *
 * Null means "no such file" (or an unreadable one), which is a state the
 * caller has an answer for — a paused pass whose transcript cannot be copied
 * out resumes on the same branch with its context declared lost — so this
 * reports rather than throws.
 *
 * Two details make the bytes trustworthy. The exec runs with `Tty: true`, so
 * the daemon hands back a **raw** stream rather than Docker's multiplexed
 * frames, which no caller here could safely strip out of file content. A TTY
 * then rewrites newlines, so the file is read as `base64` and decoded on this
 * side: one long line, no newlines to rewrite, and byte-exact either way. The
 * path travels in the environment rather than the command line, so nothing in
 * a session id can reach `bash` as syntax.
 */
export async function readContainerFile(
  container: Docker.Container,
  filePath: string
): Promise<Buffer | null> {
  const exec = await container.exec({
    Cmd: ["bash", "-c", 'base64 -w0 -- "$INTERLUDE_FILE"'],
    Env: [`INTERLUDE_FILE=${filePath}`],
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
  });

  const stream = await exec.start({});
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));

  const exitCode = await awaitExecExit(exec, stream);
  if (exitCode !== 0) return null;

  // Whitespace is the TTY's, never the payload's: `base64 -w0` emits one line.
  const encoded = Buffer.concat(chunks).toString("utf8").replace(/\s+/g, "");
  if (encoded === "") return null;
  return Buffer.from(encoded, "base64");
}

/**
 * Write one file into a container, creating its directory (issue #169).
 *
 * The content goes in over the exec's **stdin** rather than through the
 * command line or the environment: a transcript is unbounded (a long pass's is
 * megabytes) and both of those have a limit the caller could not see coming.
 * Writing through a process that runs as the container's own user is also what
 * makes the file the agent's to append to — the harness appends to the same
 * transcript when it resumes the session, so ownership is not cosmetic.
 *
 * Throws on failure, unlike the read: a caller that asked for a file to exist
 * and did not get one has nothing to fall back to at this level.
 */
export async function writeContainerFile(
  container: Docker.Container,
  filePath: string,
  contents: Buffer | string
): Promise<void> {
  const exec = await container.exec({
    Cmd: [
      "bash",
      "-c",
      'mkdir -p -- "$(dirname -- "$INTERLUDE_FILE")" && cat > "$INTERLUDE_FILE"',
    ],
    Env: [`INTERLUDE_FILE=${filePath}`],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = (await exec.start({
    hijack: true,
    stdin: true,
  })) as NodeJS.ReadWriteStream;
  stream.write(contents);
  stream.end();

  const exitCode = await awaitExecExit(exec, stream);
  if (exitCode !== 0) {
    throw new Error(`Writing ${filePath} into the container failed (exit ${exitCode})`);
  }
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
 * Has the daemon definitively lost this container? Answers only when it can:
 * true on a 404, false when the container is there, and *throws* on anything
 * else, so a daemon that cannot answer is never mistaken for one that said
 * "gone". Its caller folds that into `unknown` — see
 * {@link observeContainerAbsent}, which is what everything uses.
 */
async function probeContainerAbsent(name: string): Promise<boolean> {
  try {
    await getDocker().getContainer(name).inspect();
    return false;
  } catch (err) {
    if ((err as { statusCode?: number })?.statusCode === 404) return true;
    throw err;
  }
}

/**
 * Whether a container (by name) is gone, as three outcomes: true = the daemon
 * has definitively lost it, false = it is there, null = the daemon did not
 * answer (issue #159).
 *
 * Asks about *existence*, not liveness, which is why it cannot reuse
 * {@link isContainerRunning}: an entry in `setup` has been created but not
 * started yet, and a parked pass is deliberately `docker stop`ped since #93, so
 * that predicate would call both of those gone.
 *
 * Null is the point. Both callers act on absence — the queue frees the slot, a
 * completing task drops its handle — and acting on a *guess* is worse than the
 * problem: freeing a slot out from under live work overcommits the box, and a
 * daemon degraded enough to error is the likeliest companion of a box under
 * memory pressure. So unknown decides nothing, exactly as the agent-container
 * census reports unknown rather than none (#152), and it is bounded on the
 * shared Docker-probe timeout because an unresponsive connection has no timeout
 * of its own and both call sites sit in paths that must not stall (#115, #128).
 */
export async function observeContainerAbsent(name: string): Promise<boolean | null> {
  const outcome = await runBoundedProbe(
    () => probeContainerAbsent(name),
    DOCKER_PROBE_TIMEOUT_MS
  );
  if (outcome.ok) return outcome.value;
  if (outcome.reason === "timeout") {
    console.error(
      `[docker] container ${name} existence probe timed out after ` +
        `${DOCKER_PROBE_TIMEOUT_MS}ms — left uncorroborated`
    );
  } else {
    console.error(`[docker] container ${name} existence probe failed:`, outcome.error);
  }
  return null;
}

/** Force-remove a container by name — for reaping a dead pass's container
 * whose `RunningContainer` handle the orchestrator no longer holds (issue #95). */
export async function removeContainerByName(name: string): Promise<void> {
  await forceRemove(getDocker().getContainer(name));
}
