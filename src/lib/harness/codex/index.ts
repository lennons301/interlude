/**
 * The Codex CLI adapter (issue #221) — the second harness, behind the seam
 * issue #214 widened for it.
 *
 * Codex runs headless as `codex exec --json`: JSONL events on stdout, the
 * prompt on stdin, approvals and its own sandbox bypassed because the container
 * *is* the sandbox, and a prior session continued with `codex exec resume
 * <id>`. Everything vendor-specific is here or in this directory — the exec
 * environment and command (`buildCodexTurnEnv`, `buildCodexTurnCommand`), the
 * effort mapping, the skill invocation, the session artefact, the image
 * (`./image.ts`), the stream (`./stream-parser.ts`) and how a turn's end is
 * read (`./outcome.ts`) — and the orchestrator sees a `TurnResult` in the
 * fleet's vocabulary and nothing else.
 *
 * **Credentials are exec-scoped, and where the CLI wants a file, the file is
 * exec-scoped too.** The lane's `auth` values pass through into the exec
 * environment exactly as Claude Code's do: an API key as `CODEX_API_KEY`, which
 * the CLI reads natively (measured on 0.149.1 and 0.153.4: `OPENAI_API_KEY`
 * alone sends no bearer at all). The ChatGPT-plan credential is the documented
 * CI path — a seeded `auth.json` in the Codex home — so the turn script points
 * `CODEX_HOME` at a directory it creates for this one exec, writes
 * `auth.json` there from the `CODEX_AUTH_JSON` variable (mode 0600), and
 * removes the whole directory when the turn ends, on every exit path bash sees
 * (an EXIT trap, armed before the write). A turn killed outright — an OOM, a
 * `docker kill` of the exec — runs no trap, so the script also sweeps any such
 * home left by an earlier turn before it starts: nothing persists in the
 * container past the next turn, and a parked or idle container holds no
 * credential file. Reading the file back out of a running turn's exec is the
 * one window, as it is for a Claude turn's environment.
 *
 * **Sessions outlive the per-exec home.** The CLI keeps a thread's replayable
 * state as one rollout file under `$CODEX_HOME/sessions/<y>/<m>/<d>/rollout-
 * <timestamp>-<thread id>.jsonl`, finds it on `resume` by scanning that tree
 * for a file of that canonical name (measured: no index needed — a fresh home
 * holding only the file resumes; a file not named that way is refused as
 * non-canonical), and appends to the same file on each resumed turn. So the
 * per-exec home's `sessions` is a symlink to a persistent directory
 * (`CODEX_SESSIONS_DIR`), and the cleanup moves each rollout the CLI wrote
 * onto a deterministic name — the same canonical shape with a fixed sentinel
 * timestamp, under one subdirectory — because the timestamp the CLI puts in
 * the name is the one thing `sessionArtifactPaths(sessionId, cwd)` cannot
 * know. That deterministic path is the adapter's artefact (`codexRolloutPath`);
 * a pause copies it out and a resume puts it back, and the CLI finds it there.
 *
 * **A base URL is a per-exec provider config.** Codex takes a third-party
 * endpoint through `model_providers` in `config.toml`, so when the lane
 * declares a base URL the script writes a `config.toml` in the per-exec home
 * naming the endpoint and, as `env_key`, the lane's credential variable —
 * the Responses wire, which is the only one the CLI still speaks. A lane with
 * no base URL writes no config and the CLI's built-in OpenAI provider answers,
 * authenticated by `CODEX_API_KEY` or `auth.json` as above.
 *
 * **Bounds.** Codex has no `--max-turns` or `--max-budget-usd`; `maxTurns`
 * and `maxBudgetUsd` on the command input are accepted and ignored here, and
 * the pass is bounded by the fleet's own between-turn accounting (#175) and by
 * the per-exec wall clock issue #220 adds. `features.plugins=false` is passed
 * because a fresh Codex home otherwise clones the plugin marketplace from
 * GitHub at every turn start — a network dependency and seconds of wall clock
 * the per-exec home would pay on every exec (measured; the flag stops it).
 *
 * The security posture Claude Code's adapter states carries over unchanged
 * (issues #28, #62): auth is exec-scoped, the reviewer PAT never enters a
 * container, and `ghToken` is supplied only for a generation-session exec.
 */

import { AGENT_WORKDIR } from "../../docker/workdir";
import type {
  HarnessAdapter,
  HarnessCommandInput,
  HarnessExecEnvInput,
} from "../adapter";
import { requireHarnessDescriptor } from "../descriptors";
import { CODEX_IMAGE } from "./image";
import { createOutputHandler } from "./stream-parser";

export const CODEX_ADAPTER_ID = "codex";

/** The prompt travels in the environment and is piped to the CLI's stdin
 * (`codex exec … -`), so it never lands on a command line. */
export const CODEX_PROMPT_ENV = "CODEX_PROMPT";

/**
 * The lane variable holding a ChatGPT-plan credential: the contents of a
 * `~/.codex/auth.json` written by `codex login`. Materialised into the
 * per-exec home by the turn script and removed with it — see the module note.
 * Named in `lanes.yaml` on the left of the subscription lane's `auth` mapping.
 */
export const CODEX_AUTH_JSON_ENV = "CODEX_AUTH_JSON";

/** Where a lane's base URL lands for this harness: an environment variable the
 * turn script turns into a per-exec `config.toml` provider entry. */
export const CODEX_BASE_URL_ENV = "CODEX_BASE_URL";

/** The credential variable that provider entry names as its `env_key`. */
export const CODEX_PROVIDER_ENV_KEY_ENV = "CODEX_PROVIDER_ENV_KEY";

/** The provider id the per-exec config declares and selects. */
export const CODEX_PROVIDER_ID = "interlude";

/** The persistent sessions directory every per-exec home's `sessions` links
 * to, and the subdirectory the cleanup normalises rollouts into. */
export const CODEX_SESSIONS_DIR = "/home/node/.codex-sessions";
export const CODEX_ROLLOUT_DIR = `${CODEX_SESSIONS_DIR}/interlude`;

/** The sentinel timestamp every normalised rollout carries — the canonical
 * name's shape, with the one component the adapter cannot know fixed. */
export const CODEX_ROLLOUT_TIMESTAMP = "2000-01-01T00-00-00";

/** `mktemp -d` template for the per-exec home: under the agent's home, not
 * `/tmp`, because the CLI refuses helper binaries under a temporary dir. */
export const CODEX_EXEC_HOME_TEMPLATE = "/home/node/.codex-exec.XXXXXX";

/** Every per-exec home, for the sweep of any a killed turn left behind. */
export const CODEX_EXEC_HOME_GLOB = "/home/node/.codex-exec.*";

/**
 * Fleet effort level -> Codex `model_reasoning_effort`. The fleet's five levels
 * were taken from Claude Code's `--effort` enum (issue #81); Codex's dial has
 * the same four lower rungs and tops out at `xhigh` for the GPT-5 family, so
 * the fleet's top level collapses onto Codex's top level rather than being
 * omitted — a ticket asking for the most effort gets the most Codex offers.
 * Anything outside the fleet vocabulary has no equivalent and is omitted.
 */
export const CODEX_EFFORTS: Readonly<Record<string, string>> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
};

export function mapCodexEffort(level: string): string | null {
  return CODEX_EFFORTS[level] ?? null;
}

/** The credential variable a per-exec provider config names: the lane's
 * first auth variable that is not the ChatGPT credential file. */
export function providerEnvKey(auth: Readonly<Record<string, string>>): string | null {
  return Object.keys(auth).find((name) => name !== CODEX_AUTH_JSON_ENV) ?? null;
}

/**
 * Env for a Codex turn exec. Auth is exec-scoped, mirroring GIT_AUTH_TOKEN and
 * Claude Code's adapter: only the chosen lane's variables are present, and
 * none lands in the container's persistent environment.
 */
export function buildCodexTurnEnv(input: HarnessExecEnvInput): string[] {
  const env = [
    `${CODEX_PROMPT_ENV}=${input.prompt}`,
    `GIT_AUTH_TOKEN=${input.gitAuthToken}`,
  ];

  for (const [name, value] of Object.entries(input.lane.auth)) {
    env.push(`${name}=${value}`);
  }

  if (input.lane.baseUrl) {
    env.push(`${CODEX_BASE_URL_ENV}=${input.lane.baseUrl}`);
    const key = providerEnvKey(input.lane.auth);
    if (key !== null) env.push(`${CODEX_PROVIDER_ENV_KEY_ENV}=${key}`);
  }

  if (input.ghToken) {
    env.push(`GH_TOKEN=${input.ghToken}`);
  }

  return env;
}

/** A Codex thread id as the CLI mints them (a UUID); the one shape a resume
 * puts on the command line. */
const SESSION_ID_SHAPE = /^[A-Za-z0-9-]+$/;

/**
 * The bash script one Codex turn runs inside the container, under `bash -c`
 * (see the module note for what each part is for). Pure and exported so the
 * flag wiring and the cleanup are unit-testable without a live exec.
 */
export function buildCodexTurnCommand(input: HarnessCommandInput): string {
  const invocation = ["codex", "exec"];
  if (input.sessionId) {
    if (!SESSION_ID_SHAPE.test(input.sessionId)) {
      // Defence in depth: the id reaches `bash -c`, and a resume against an id
      // this CLI could not have minted is a fleet bug, not a turn to run.
      throw new Error(`Refusing to resume a Codex session with id "${input.sessionId}"`);
    }
    invocation.push("resume", `'${input.sessionId}'`);
  }
  invocation.push(
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "-c",
    "features.plugins=false"
  );
  if (input.lane.model) {
    // Single-quoted, as Claude Code's is: a model id is a provider's slug and
    // this runs under `bash -c`.
    invocation.push("-m", `'${input.lane.model}'`);
  }
  const effort = input.effort ? mapCodexEffort(input.effort) : null;
  if (effort) {
    // TOML string value; always one of the CLI's bounded words.
    invocation.push("-c", `'model_reasoning_effort="${effort}"'`);
  }
  // The prompt, from stdin.
  invocation.push("-");

  return [
    "set -o pipefail",
    `cd ${AGENT_WORKDIR} || exit 1`,
    // A turn killed outright ran no trap; its home — and its credential file —
    // goes now, before this turn's is made.
    `rm -rf -- ${CODEX_EXEC_HOME_GLOB}`,
    `mkdir -p ${CODEX_ROLLOUT_DIR}`,
    `CODEX_HOME="$(mktemp -d ${CODEX_EXEC_HOME_TEMPLATE})" || exit 1`,
    "export CODEX_HOME",
    "interlude_codex_cleanup() {",
    // Every rollout the CLI wrote under its dated tree moves onto the
    // deterministic name the adapter's artefact path derives; one the CLI
    // appended to in place is already there.
    `  find ${CODEX_SESSIONS_DIR} -type f -name 'rollout-*.jsonl' -not -path '${CODEX_ROLLOUT_DIR}/*' -print0 2>/dev/null | while IFS= read -r -d '' rollout; do`,
    '    name="${rollout##*/}"; name="${name%.jsonl}"',
    `    mv -f -- "$rollout" "${CODEX_ROLLOUT_DIR}/rollout-${CODEX_ROLLOUT_TIMESTAMP}-\${name: -36}.jsonl"`,
    "  done",
    // The credential file, the provider config and the CLI's state go with
    // the per-exec home; the sessions symlink goes, its target stays.
    '  rm -rf -- "$CODEX_HOME"',
    "}",
    "trap interlude_codex_cleanup EXIT",
    `ln -s ${CODEX_SESSIONS_DIR} "$CODEX_HOME/sessions"`,
    `if [ -n "\${${CODEX_AUTH_JSON_ENV}:-}" ]; then (umask 077 && printf '%s' "$${CODEX_AUTH_JSON_ENV}" > "$CODEX_HOME/auth.json"); fi`,
    `if [ -n "\${${CODEX_BASE_URL_ENV}:-}" ]; then`,
    `  printf 'model_provider = "${CODEX_PROVIDER_ID}"\\n\\n[model_providers.${CODEX_PROVIDER_ID}]\\nname = "Interlude lane"\\nbase_url = "%s"\\nwire_api = "responses"\\n' "$${CODEX_BASE_URL_ENV}" > "$CODEX_HOME/config.toml"`,
    `  if [ -n "\${${CODEX_PROVIDER_ENV_KEY_ENV}:-}" ]; then printf 'env_key = "%s"\\n' "$${CODEX_PROVIDER_ENV_KEY_ENV}" >> "$CODEX_HOME/config.toml"; fi`,
    "fi",
    `printf '%s' "$${CODEX_PROMPT_ENV}" | ${invocation.join(" ")}`,
  ].join("\n");
}

/**
 * How Codex is asked to run a skill: the `$skill-name` mention the CLI
 * documents for explicit invocation, with the agenda after it — the shape the
 * spec (#213) chose. Whether `codex exec` honours the mention is the proof
 * ticket's to check (#224), which is why this adapter declares
 * `userInvokedSkills: false` until it does: no generation session is routed
 * here, so this text reaches no agent yet.
 */
export function composeCodexSkillInvocation(skill: string, agenda: string | null): string {
  const trimmed = agenda?.trim();
  return trimmed ? `$${skill} ${trimmed}` : `$${skill}`;
}

/** The deterministic rollout path for one thread — see the module note. */
export function codexRolloutPath(sessionId: string): string {
  return `${CODEX_ROLLOUT_DIR}/rollout-${CODEX_ROLLOUT_TIMESTAMP}-${sessionId}.jsonl`;
}

/**
 * One file is the whole session: the rollout the CLI finds by thread id under
 * `resume` and appends to on every resumed turn. Independent of the working
 * directory — Codex keys a thread by its id, not by where it ran.
 */
export function codexSessionArtifactPaths(sessionId: string): string[] {
  return [codexRolloutPath(sessionId)];
}

const descriptor = requireHarnessDescriptor(CODEX_ADAPTER_ID);

export const codexAdapter: HarnessAdapter = {
  id: CODEX_ADAPTER_ID,
  image: CODEX_IMAGE,
  // Read from the table rather than restated, so the adapter cannot disagree
  // with what the lane parser was told about it.
  capabilities: descriptor.capabilities,
  buildExecEnv: buildCodexTurnEnv,
  buildCommand: buildCodexTurnCommand,
  // The lane is not handed on: this stream carries no quota telemetry to
  // attribute to an account (issue #175's reason for passing it).
  createOutputHandler: (taskId) => createOutputHandler(taskId),
  composeSkillInvocation: composeCodexSkillInvocation,
  sessionArtifactPaths: codexSessionArtifactPaths,
  mapEffort: mapCodexEffort,
};
