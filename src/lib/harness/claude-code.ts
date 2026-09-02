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
 * A lane that declares its own prices passes no `--max-budget-usd` — see the
 * note at that branch, which is a finding rather than a preference.
 */
export function buildClaudeTurnCommand(input: HarnessCommandInput): string {
  const config = getConfig();

  const cmdParts = [
    // The pass's working directory. Also encoded, mangled, in the path the
    // harness keeps its session transcript at — see `containerTranscriptDir`
    // in `src/lib/quota/session-transcript.ts`, which a resumed pass (#169)
    // restores into: changing this changes that.
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
  ];

  // The harness's own spend ceiling, and only where it means anything (issue
  // #175).
  //
  // `--max-budget-usd` is enforced by the CLI against the CLI's *own* cost
  // figure, and that figure is Anthropic list prices applied to whatever model
  // it was handed: measured, it billed a turn on a free model $0.194985, 67x
  // what the same tokens cost on the lane's published prices. Handing it a
  // ceiling in the fleet's currency would therefore stop a turn at roughly a
  // sixtieth of the budget the operator set — and the orchestrator would not
  // see a failure, because a budget-stopped turn is not `error_max_turns`: the
  // pass would end early, mid-work, and be parked as though it had finished.
  // "A lane that is cheap and fails every ticket is not cheap" is exactly that
  // failure.
  //
  // So a lane that declares prices is not given a ceiling the harness would
  // misapply. A lane with no prices — Anthropic-direct, where the CLI's figure
  // is its own list price and correct — keeps the flag and is unchanged by any
  // of this.
  //
  // What still bounds a priced turn, exactly: `--max-turns` inside it, and
  // between turns the fleet's own accounting, which since this ticket charges
  // the lane's real prices — `attemptExhaustion` for an implement or repair
  // pass, and the daily autonomous cap, which counts every autonomous pass
  // kind. **A review or triage pass has no in-turn ceiling on a priced lane**:
  // its `DEFAULT_REVIEW_BUDGET_USD` / `DEFAULT_TRIAGE_BUDGET_USD` reached the
  // harness through this flag and nowhere else. That is a real loss and it is
  // still the better trade: enforced against the CLI's figure those ceilings
  // cut a review off at a fraction of themselves — roughly $0.08 of real spend
  // for a $5 budget at the measured 67x — mid-work and invisibly, which is a
  // review pass that silently reviews half a PR. Converting the ceiling into
  // the CLI's currency would mean modelling its pricing, and a wrong ratio is
  // that same invisible truncation back again.
  //
  // The question is asked of the lane *definition* (`declaresPrices`), never
  // of this pass's resolved tier: "does the CLI price this provider?" is a
  // fact about the endpoint, true before any tier resolves. Keying it on the
  // per-tier `prices` would put the ceiling back the moment no tier resolved —
  // the pinned-model case — which is precisely the invisible mid-work
  // truncation this branch exists to remove.
  if (!input.lane.declaresPrices) {
    cmdParts.push(
      "--max-budget-usd",
      String(input.maxBudgetUsd ?? config.maxBudgetUsd)
    );
  }

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
  buildExecEnv: buildTurnEnv,
  buildCommand: buildClaudeTurnCommand,
  // The lane's id, not the lane: the parser only needs to know which account's
  // quota an observed `rate_limit_event` describes (issue #175), and handing it
  // the auth values as well would put credentials on the logging path.
  createOutputHandler: (taskId, lane) => createOutputHandler(taskId, lane.id),
};
