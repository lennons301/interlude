/**
 * The Claude Code adapter (issue #172) — the one harness that ships.
 *
 * Everything here was already in the container manager and already tested;
 * what this ticket changed is where the values come from. The exec environment
 * and the command are now built **from a resolved lane**: its auth map, its
 * base URL, and the model identifier it gives the pass's tier. Nothing in this
 * module reads `getConfig()` for a credential or an endpoint, which is what
 * makes "flip the subscription for a metered API" a configuration change.
 *
 * The security posture is unchanged and load-bearing (issues #28, #62):
 * auth is exec-scoped, never in the container's persistent environment; the
 * reviewer PAT never enters a container at all; and `ghToken` is supplied by
 * the caller only for a generation-session exec, so every autonomous pass kind
 * carries no GitHub CLI token by construction rather than by a check here.
 */

import { getConfig } from "../config";
import { createOutputHandler } from "../orchestrator/output-parser";
import type {
  HarnessAdapter,
  HarnessCommandInput,
  HarnessExecEnvInput,
} from "./adapter";

/**
 * Where a lane's base URL lands for this harness. Claude Code speaks the
 * Anthropic Messages API and appends its own `/v1/messages`, which is why a
 * lane pointing at a compatible provider names the provider's *root* rather
 * than its OpenAI-shaped `/v1`.
 */
export const CLAUDE_CODE_BASE_URL_ENV = "ANTHROPIC_BASE_URL";

/**
 * Env for a Claude turn exec. Auth is exec-scoped, mirroring GIT_AUTH_TOKEN:
 * no long-lived token lands in the container's persistent env, so a container
 * that outlives a turn (a parked pass, an idle interactive session) holds no
 * credential anyone could read out of it.
 *
 * The lane decides which auth variables appear at all. A subscription lane
 * sets `CLAUDE_CODE_OAUTH_TOKEN`; an OpenRouter lane sets
 * `ANTHROPIC_AUTH_TOKEN` and a base URL and deliberately sets no API key. Only
 * the chosen lane's variables are present, so two credentials can never race
 * to authenticate one turn.
 */
export function buildTurnEnv(input: HarnessExecEnvInput): string[] {
  const env = [
    `CLAUDE_PROMPT=${input.prompt}`,
    `GIT_AUTH_TOKEN=${input.gitAuthToken}`,
  ];

  for (const [name, value] of Object.entries(input.lane.auth)) {
    env.push(`${name}=${value}`);
  }

  if (input.lane.baseUrl) {
    env.push(`${CLAUDE_CODE_BASE_URL_ENV}=${input.lane.baseUrl}`);
  }

  if (input.ghToken) {
    env.push(`GH_TOKEN=${input.ghToken}`);
  }

  return env;
}

/**
 * The bash command a Claude turn runs inside the container. Pure and exported
 * so the flag wiring — the lane's `--model` (issues #74, #172) and the
 * `--effort` level (issue #81) — is unit-testable without a live Docker exec.
 * `maxTurns`/`maxBudgetUsd` fall back to the configured defaults; a lane with
 * no model identifier for the pass passes no `--model` at all, leaving the
 * harness to resolve its own default exactly as before any of this existed.
 */
export function buildClaudeTurnCommand(input: HarnessCommandInput): string {
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
    String(input.maxTurns ?? config.maxTurns),
    "--max-budget-usd",
    String(input.maxBudgetUsd ?? config.maxBudgetUsd),
  ];

  if (input.lane.model) {
    // Single-quote the model id: real ids can carry shell glob metacharacters
    // (e.g. "claude-opus-4-8[1m]") and slashes (an OpenRouter slug), and this
    // runs under `bash -c`.
    cmdParts.push("--model", `'${input.lane.model}'`);
  }

  if (input.effort) {
    // The value is always one of the CLI's bounded levels — both entry points
    // validate against the same allowlist (the ticket directive clamps, the
    // env is checked in config.ts), so no metacharacter can reach here. Still
    // single-quoted for the same defence-in-depth reason as the model above,
    // since this runs under `bash -c`.
    cmdParts.push("--effort", `'${input.effort}'`);
  }

  if (input.sessionId) {
    cmdParts.push("--resume", input.sessionId);
  }

  return cmdParts.join(" ");
}

export const claudeCodeAdapter: HarnessAdapter = {
  id: "claude-code",
  baseUrlEnvVar: CLAUDE_CODE_BASE_URL_ENV,
  buildExecEnv: buildTurnEnv,
  buildCommand: buildClaudeTurnCommand,
  createOutputHandler,
};

const ADAPTERS: Readonly<Record<string, HarnessAdapter>> = {
  [claudeCodeAdapter.id]: claudeCodeAdapter,
};

/**
 * The adapter a resolved lane names. Throws rather than defaulting: a lane
 * whose adapter does not exist is a config error the parser already refuses,
 * so reaching here means the two have drifted and guessing would run the pass
 * on a harness nobody chose.
 */
export function getHarnessAdapter(id: string): HarnessAdapter {
  const adapter = ADAPTERS[id];
  if (!adapter) {
    throw new Error(
      `no harness adapter for "${id}" — known adapters: ${Object.keys(ADAPTERS).join(", ")}`
    );
  }
  return adapter;
}
