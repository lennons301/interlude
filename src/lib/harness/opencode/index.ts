/**
 * The OpenCode adapter (issue #222) — a second harness behind the seam issue
 * #214 widened, and the first to speak to OpenRouter natively: the shipped
 * lane runs the same credential and the same GLM models the fleet already
 * reaches through OpenRouter's Anthropic-compatible skin under Claude Code, so
 * the two paths can be compared.
 *
 * OpenCode runs headless as `opencode run --format json`: JSON events on
 * stdout, the prompt on stdin, the model pinned in the CLI's own
 * `provider/model` form, and a prior session continued with `--session <id>`.
 * Everything vendor-specific is here or in this directory — the exec
 * environment and command (`buildOpenCodeTurnEnv`, `buildOpenCodeTurnCommand`),
 * the effort mapping, the skill invocation, the session artefact, the image
 * (`./image.ts`), the stream (`./stream-parser.ts`) and how a turn's end is
 * read (`./outcome.ts`) — and the orchestrator sees a `TurnResult` in the
 * fleet's vocabulary and nothing else. Every measurement below is against
 * 1.18.29 in the built image, on OpenRouter.
 *
 * **Credentials pass through as the variables the CLI already reads.** The
 * lane's `auth` values land in the exec environment exactly as Claude Code's
 * do: OpenCode enables its `openrouter` provider from `OPENROUTER_API_KEY`
 * with no `/connect` and no config (measured), so the shipped lane's mapping
 * is the variable under its own name. Exec-scoped, never in the container's
 * persistent environment, and never on the command line.
 *
 * **Permissions and the endpoint are a per-exec config.** The turn script
 * writes `opencode.json` at a fixed path inside the container and names it in
 * `OPENCODE_CONFIG`, which the CLI merges over its defaults: `permission:
 * { "*": "allow" }` so a headless turn is never asked (measured: a shell
 * command ran with no prompt and no `--auto`), and — only when the lane
 * declares a `base_url` — a `provider.<id>.options.baseURL` override for the
 * provider the lane's model names, since a `provider/model` id carries its
 * provider in front. The file holds no secret, which is why it needs no trap
 * to remove it. `--pure` runs without external plugins, so a fresh container
 * fetches nothing from a plugin registry at every turn start.
 *
 * **The session is one SQLite file.** The CLI keeps every session in one
 * database, in WAL mode; the turn environment pins its path with
 * `OPENCODE_DB` (measured honoured) so the CLI's release-channel naming can
 * never move it, and the turn script checkpoints the WAL into the main file
 * after the CLI exits (`opencode db "PRAGMA wal_checkpoint(TRUNCATE)"`, ~1s,
 * measured: the WAL held the whole session until it ran). That one file is the
 * adapter's artefact (`sessionArtifactPaths`): copied into a fresh container,
 * `--session <id>` resumed the conversation with no other state — with the
 * same repository root commit and with a different one (measured both).
 *
 * **A terminal event of the adapter's own.** `run --format json` ends with the
 * process exit and no event, so the script prints `interlude.turn_exit` with
 * the CLI's exit code once the checkpoint is done — after it, so a pause that
 * copies the database out reads a complete one. `./outcome.ts` has the rest.
 *
 * **Effort is the CLI's `--variant`, and the fleet's five levels are its
 * names.** OpenCode's variant vocabulary is `low | medium | high | xhigh |
 * max` (plus `none`/`minimal`), resolved *per model* against the variants that
 * model defines: for a reasoning model on OpenRouter it defines `low`,
 * `medium` and `high` as the provider's `reasoning.effort`, and a variant the
 * model does not define is dropped silently (measured: `--variant max` on GLM
 * 5.3 Flash ran as if unset, exit 0). So the mapping is the identity on the
 * fleet's vocabulary and the flag is always passed; whether a level is applied
 * is the model's, and the fleet cannot see which. The one case the flag is
 * *omitted* is a level outside the fleet's vocabulary, which neither entry
 * point admits.
 *
 * **Bounds.** OpenCode has no `--max-turns` or `--max-budget-usd`; `maxTurns`
 * and `maxBudgetUsd` on the command input are accepted and ignored here. What
 * bounds a pass is the fleet's own between-turn accounting (#175, at the
 * lane's declared prices) and the orchestrator's per-exec wall clock (#220,
 * `turnWallClockMs`), the one in-turn bound on this harness.
 *
 * The security posture Claude Code's adapter states carries over unchanged
 * (issues #28, #62): auth is exec-scoped, the reviewer PAT never enters a
 * container, and `ghToken` is supplied only for a generation-session exec.
 */

import { AGENT_WORKDIR } from "../../docker/workdir";
import { ALLOWED_TICKET_EFFORTS } from "../../orchestrator/autonomy/budgets";
import type {
  HarnessAdapter,
  HarnessCommandInput,
  HarnessExecEnvInput,
} from "../adapter";
import { requireHarnessDescriptor } from "../descriptors";
import { OPENCODE_IMAGE } from "./image";
import { OPENCODE_TURN_EXIT_EVENT } from "./outcome";
import { createOutputHandler } from "./stream-parser";

export const OPENCODE_ADAPTER_ID = "opencode";

/** The prompt travels in the environment and is piped to the CLI's stdin, so
 * it never lands on a command line. */
export const OPENCODE_PROMPT_ENV = "OPENCODE_PROMPT";

/** The CLI's own variable naming its database file — pinned per exec so the
 * session artefact is at one path whatever release channel the CLI thinks it
 * is on (measured: honoured by `opencode db path`). */
export const OPENCODE_DB_ENV = "OPENCODE_DB";
export const OPENCODE_DB_PATH = "/home/node/.local/share/opencode/interlude.db";

/** The CLI's own variable naming an extra config file, merged over its
 * defaults; the turn script writes the file at this path every turn. */
export const OPENCODE_CONFIG_ENV = "OPENCODE_CONFIG";
export const OPENCODE_CONFIG_PATH = "/home/node/.opencode-exec/opencode.json";

/** Where a lane's base URL lands for this harness: an environment variable the
 * turn script turns into the per-exec config's provider override, beside the
 * provider it applies to. */
export const OPENCODE_BASE_URL_ENV = "OPENCODE_BASE_URL";
export const OPENCODE_PROVIDER_ENV = "OPENCODE_PROVIDER";

/** How long the post-turn checkpoint may take before the turn ends without it
 * — the artefact is then whatever the main file holds, which a resume would
 * find incomplete and start fresh from (the declared fallback). */
export const OPENCODE_CHECKPOINT_TIMEOUT_SECONDS = 60;

/**
 * The provider an OpenCode model id names — the segment before the first
 * slash of `provider/model` (an OpenRouter slug keeps its own slash after it:
 * `openrouter/z-ai/glm-5.3-flash`). Null for an id with no provider, which the
 * CLI could not run either.
 */
export function providerOf(model: string | null): string | null {
  if (model === null) return null;
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : null;
}

/**
 * Env for an OpenCode turn exec. Auth is exec-scoped, mirroring GIT_AUTH_TOKEN
 * and Claude Code's adapter: only the chosen lane's variables are present, and
 * none lands in the container's persistent environment.
 */
export function buildOpenCodeTurnEnv(input: HarnessExecEnvInput): string[] {
  const env = [
    `${OPENCODE_PROMPT_ENV}=${input.prompt}`,
    `GIT_AUTH_TOKEN=${input.gitAuthToken}`,
    `${OPENCODE_DB_ENV}=${OPENCODE_DB_PATH}`,
    `${OPENCODE_CONFIG_ENV}=${OPENCODE_CONFIG_PATH}`,
  ];

  for (const [name, value] of Object.entries(input.lane.auth)) {
    env.push(`${name}=${value}`);
  }

  if (input.lane.baseUrl) {
    env.push(`${OPENCODE_BASE_URL_ENV}=${input.lane.baseUrl}`);
    // The override is per provider, and the provider is the model's prefix. A
    // lane pinning a raw id with no provider gets no override — the CLI would
    // refuse the id before any endpoint mattered.
    const provider = providerOf(input.lane.model);
    if (provider !== null) env.push(`${OPENCODE_PROVIDER_ENV}=${provider}`);
  }

  if (input.ghToken) {
    env.push(`GH_TOKEN=${input.ghToken}`);
  }

  return env;
}

/**
 * Fleet effort level -> OpenCode `--variant`. The identity on the fleet's
 * vocabulary (see the module note: the CLI's variant names *are* these five,
 * and it drops one the model does not define); anything outside it has no
 * equivalent and is omitted.
 */
export function mapOpenCodeEffort(level: string): string | null {
  return (ALLOWED_TICKET_EFFORTS as readonly string[]).includes(level) ? level : null;
}

/** An OpenCode session id as the CLI mints them (`ses_` + alphanumerics); the
 * one shape a resume puts on the command line. */
const SESSION_ID_SHAPE = /^[A-Za-z0-9_-]+$/;

/**
 * The bash script one OpenCode turn runs inside the container, under
 * `bash -c` (see the module note for what each part is for). Pure and exported
 * so the flag wiring, the config and the terminal event are unit-testable
 * without a live exec.
 */
export function buildOpenCodeTurnCommand(input: HarnessCommandInput): string {
  const invocation = ["opencode", "run", "--format", "json", "--pure"];

  if (input.lane.model) {
    // Single-quoted, as Claude Code's is: a model id is a provider's slug and
    // this runs under `bash -c`.
    invocation.push("--model", `'${input.lane.model}'`);
  }

  // Through the adapter's own mapping (issue #214): always one of the fleet's
  // bounded levels, so no metacharacter can reach here. Single-quoted for the
  // same defence-in-depth reason as the model.
  const effort = input.effort ? mapOpenCodeEffort(input.effort) : null;
  if (effort) {
    invocation.push("--variant", `'${effort}'`);
  }

  if (input.sessionId) {
    if (!SESSION_ID_SHAPE.test(input.sessionId)) {
      // Defence in depth: the id reaches `bash -c`, and a resume against an id
      // this CLI could not have minted is a fleet bug, not a turn to run.
      throw new Error(`Refusing to resume an OpenCode session with id "${input.sessionId}"`);
    }
    invocation.push("--session", `'${input.sessionId}'`);
  }

  return [
    "set -o pipefail",
    // Before the terminal event is armed, deliberately: a workspace that is
    // not there is the container's failure, and a stream with no exit event
    // is the null outcome the interruption bound owns.
    `cd ${AGENT_WORKDIR} || exit 1`,
    `mkdir -p "$(dirname ${OPENCODE_CONFIG_PATH})"`,
    // The per-exec config: permissions allowed outright, and the lane's
    // endpoint for the model's provider when one is declared. Built with jq so
    // the URL is a JSON string whatever it contains.
    `jq -n --arg provider "\${${OPENCODE_PROVIDER_ENV}:-}" --arg url "\${${OPENCODE_BASE_URL_ENV}:-}" ` +
      `'{permission: {"*": "allow"}} + ` +
      `(if $url != "" and $provider != "" then {provider: {($provider): {options: {baseURL: $url}}}} else {} end)' ` +
      `> ${OPENCODE_CONFIG_PATH}`,
    // The prompt, from stdin.
    `printf '%s' "$${OPENCODE_PROMPT_ENV}" | ${invocation.join(" ")}`,
    "interlude_exit=$?",
    // The whole session into the one file a pause copies out (module note).
    `timeout ${OPENCODE_CHECKPOINT_TIMEOUT_SECONDS} opencode db 'PRAGMA wal_checkpoint(TRUNCATE)' > /dev/null 2>&1`,
    // The adapter's terminal event, last.
    `printf '\\n{"type":"${OPENCODE_TURN_EXIT_EVENT}","exitCode":%d}\\n' "$interlude_exit"`,
  ].join("\n");
}

/**
 * How OpenCode is asked to run a skill: an instruction. The CLI has no
 * user-invoked skill syntax — skills reach the model through a `skill` tool it
 * calls itself, listing every skill under the `~/.agents/skills` folders the
 * base image installs (#215) — so the invocation names the skill, tells the
 * model to load it with that tool and follow it, and hands the agenda over as
 * the skill's argument.
 *
 * Proven on the proof ticket (#225, 1.18.29 in the built image, GLM 5.3
 * Flash on OpenRouter): this exact text, as the first line of a seed, made
 * the model call the `skill` tool for the named skill on every run — a probe
 * skill carrying an unguessable sentinel came back verbatim on the first
 * try, `to-spec` was loaded and followed to a drafted spec, and a
 * `to-tickets` generation session through the real orchestrator was loaded
 * and followed to its publish step (two issues published, unlabelled, the
 * arming confirmation asked for). That is what `userInvokedSkills: true` in
 * the descriptor rests on, and why a generation session may route here.
 */
export function composeOpenCodeSkillInvocation(skill: string, agenda: string | null): string {
  const trimmed = agenda?.trim();
  const head = `Load the skill named "${skill}" with the skill tool and follow it`;
  return trimmed ? `${head}, taking this as its argument: ${trimmed}` : `${head}.`;
}

/**
 * One file is the whole session: the CLI's database, checkpointed by the turn
 * script so the main file holds everything. Independent of the session id and
 * the working directory — the database holds every session, `--session` finds
 * one by id, and a resume worked from the copied file alone in a fresh
 * container whatever the repository's root commit (measured).
 */
export function opencodeSessionArtifactPaths(): string[] {
  return [OPENCODE_DB_PATH];
}

const descriptor = requireHarnessDescriptor(OPENCODE_ADAPTER_ID);

export const opencodeAdapter: HarnessAdapter = {
  id: OPENCODE_ADAPTER_ID,
  image: OPENCODE_IMAGE,
  // Read from the table rather than restated, so the adapter cannot disagree
  // with what the lane parser was told about it.
  capabilities: descriptor.capabilities,
  buildExecEnv: buildOpenCodeTurnEnv,
  buildCommand: buildOpenCodeTurnCommand,
  // The lane is not handed on: this stream carries no quota telemetry to
  // attribute to an account (issue #175's reason for passing it).
  createOutputHandler: (taskId) => createOutputHandler(taskId),
  composeSkillInvocation: composeOpenCodeSkillInvocation,
  sessionArtifactPaths: opencodeSessionArtifactPaths,
  mapEffort: mapOpenCodeEffort,
};
