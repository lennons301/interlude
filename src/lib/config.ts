import {
  ALLOWED_TICKET_EFFORTS,
  DEFAULT_ATTEMPT_BUDGET_USD,
  DEFAULT_OCCUPANCY_DIVERGED_MS,
  DEFAULT_OWED_REVIEW_STALL_MS,
  DEFAULT_PICKUP_WEDGED_MS,
  DEFAULT_QUEUE_HEARTBEAT_STALE_MS,
} from "./orchestrator/autonomy/budgets";
import type { FleetHealthThresholds } from "./fleet/health";
import { normalizeModelTier, tierModelId } from "./model-tiers";
import {
  resolveModelTier,
  type SettingsOverrides,
} from "./settings-resolver";

/** Parse an env value expressed in minutes into ms, falling back to a default.
 * A blank, non-numeric or non-positive value keeps the default (a mistyped
 * threshold must never silently become 0 and alarm every sweep). */
function minutesEnvMs(raw: string | undefined, defaultMs: number): number {
  if (raw == null || raw === "") return defaultMs;
  const mins = parseFloat(raw);
  return Number.isFinite(mins) && mins > 0 ? mins * 60_000 : defaultMs;
}

/**
 * Validate an `AGENT_EFFORT*` env value against the CLI's level set. Effort,
 * unlike the model (an open-ended id/alias space), is a closed enum, so a bad
 * value is both catastrophic — it reaches `--effort` on *every* turn fleet-wide
 * — and cheap to catch. An unset var stays null (CLI default); a set-but-bad
 * one warns and falls back to null rather than shipping a typo like
 * `AGENT_EFFORT=hihg` to the CLI. The ticket-directive path clamps to the same
 * set for the same reason.
 */
function normalizeEffort(raw: string | undefined): string | null {
  if (raw == null || raw === "") return null;
  if ((ALLOWED_TICKET_EFFORTS as readonly string[]).includes(raw)) return raw;
  console.warn(
    `Warning: ignoring unrecognised effort "${raw}" — expected one of ` +
      `${ALLOWED_TICKET_EFFORTS.join(", ")}. Falling back to the CLI default.`
  );
  return null;
}

export interface AppConfig {
  /** Anthropic API key (optional if using CLAUDE_CODE_OAUTH_TOKEN) */
  anthropicApiKey: string | null;
  /** Long-lived OAuth token from `claude setup-token`, injected into agent containers at exec — the sole subscription-auth path (#28) */
  claudeCodeOauthToken: string | null;
  /**
   * Model the CLI runs for an implement pass — and the base every other pass
   * falls back to (issue #74). Null = pass no `--model`, letting the CLI
   * resolve the account default (the pre-#74 behaviour), so leaving it unset
   * changes nothing. Set it to pin the tier and record it on the run row.
   */
  agentModel: string | null;
  /** Optional cheaper-tier override for review passes; falls back to `agentModel` */
  agentModelReview: string | null;
  /** Optional cheaper-tier override for triage passes; falls back to `agentModel` */
  agentModelTriage: string | null;
  /**
   * Reasoning-effort level the CLI runs an implement pass at — and the base
   * every other pass falls back to (issue #81). The headless CLI exposes this
   * as a first-class `--effort` flag (levels low | medium | high | xhigh |
   * max), orthogonal to `--model`. Null = pass no `--effort`, letting the CLI
   * resolve its own default (the pre-#81 behaviour), so leaving it unset
   * changes nothing. Set it to pin the depth and record it on the run row.
   */
  agentEffort: string | null;
  /** Optional lower-effort override for review passes; falls back to `agentEffort` */
  agentEffortReview: string | null;
  /** Optional lower-effort override for triage passes; falls back to `agentEffort` */
  agentEffortTriage: string | null;
  gitUserName: string;
  gitUserEmail: string;
  keepContainers: boolean;
  /** Max agentic turns per exec (default: 50; a ticket's max-turns directive
   * may raise an autonomous attempt's to at most 100) */
  maxTurns: number;
  /**
   * Max budget in USD (default: 20.00). Phase 5 (issue #18) changed the
   * meaning: this is the default budget per autonomous *attempt* — one claim,
   * fresh container — raisable per ticket via a `budget:` directive up to a
   * hard $75 ceiling. Interactive tasks deliberately inherit the same, more
   * generous, per-task default (it was $5 per task before Phase 5). Review
   * passes carry their own ~$5 allowance instead.
   */
  maxBudgetUsd: number;
  /** Explicit agent slot count, overriding the boot-time derivation. Null = derive from the Docker daemon */
  capacitySlots: number | null;
  /** Per-agent memory allocation in MiB (container cap + slot divisor). Null = default */
  agentMemoryMb: number | null;
  /** Domain for subdomain-based preview (e.g. "interludes.co.uk"). Null = path-based fallback */
  domain: string | null;
  /** GitHub App ID (from app settings page) */
  githubAppId: string | null;
  /** GitHub App private key PEM content */
  githubAppPrivateKey: string | null;
  /** Secret for verifying webhook signatures */
  githubWebhookSecret: string | null;
  /** Installation ID for the GitHub App on your account */
  githubAppInstallationId: string | null;
  /** Discord bot token (from Developer Portal) */
  discordBotToken: string | null;
  /** Discord application ID */
  discordApplicationId: string | null;
  /** Discord guild (server) ID — used to deep-link into project channels */
  discordGuildId: string | null;
  /**
   * PAT of the reviewer machine account, used by the orchestrator (and only
   * the orchestrator — it never enters an agent container) to post PR
   * reviews. Canonical home is Doppler `platform/prd`; it is MIRRORED into
   * `interlude/prd` because the orchestrator's service token is scoped to
   * one config. Rotation must update both places.
   */
  reviewerGithubToken: string | null;
  /** Global autonomy kill switch — autonomous pickup runs only when true */
  autonomyEnabled: boolean;
  /** Extra GitHub logins allowed to author claimable issues (repo owners always are) */
  autonomyAllowedAuthors: string[];
  /** Discord channel for fleet-level events (e.g. slot saturation). Null = log only */
  discordFleetChannelId: string | null;
  /** Thresholds for the fleet-health watchdog (issue #126), in ms. Overridable
   * in minutes via OWED_REVIEW_STALL_MINUTES / PICKUP_WEDGED_MINUTES /
   * QUEUE_HEARTBEAT_STALE_MINUTES. */
  fleetHealthThresholds: FleetHealthThresholds;
}

let _config: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (_config) return _config;

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY ?? null;
  const claudeCodeOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null;

  // Agent-container Claude auth is exec-scoped: CLAUDE_CODE_OAUTH_TOKEN (from
  // `claude setup-token`), with ANTHROPIC_API_KEY as an alternative. The old
  // mounted-credentials-file path was retired with the host `~/.claude` mount
  // (#28), so there is nothing to detect on disk here.
  if (!anthropicApiKey && !claudeCodeOauthToken) {
    console.warn(
      "Warning: No agent Claude auth configured. Set CLAUDE_CODE_OAUTH_TOKEN " +
        "(from `claude setup-token`) or ANTHROPIC_API_KEY."
    );
  }

  _config = {
    anthropicApiKey,
    claudeCodeOauthToken,
    agentModel: process.env.AGENT_MODEL ?? null,
    agentModelReview: process.env.AGENT_MODEL_REVIEW ?? null,
    agentModelTriage: process.env.AGENT_MODEL_TRIAGE ?? null,
    agentEffort: normalizeEffort(process.env.AGENT_EFFORT),
    agentEffortReview: normalizeEffort(process.env.AGENT_EFFORT_REVIEW),
    agentEffortTriage: normalizeEffort(process.env.AGENT_EFFORT_TRIAGE),
    gitUserName: process.env.GIT_USER_NAME ?? "Interlude Agent",
    gitUserEmail: process.env.GIT_USER_EMAIL ?? "agent@interlude.dev",
    keepContainers: process.env.KEEP_CONTAINERS === "true",
    maxTurns: parseInt(process.env.MAX_TURNS ?? "50", 10),
    maxBudgetUsd: parseFloat(
      process.env.MAX_BUDGET_USD ?? String(DEFAULT_ATTEMPT_BUDGET_USD)
    ),
    capacitySlots: process.env.CAPACITY_SLOTS
      ? parseInt(process.env.CAPACITY_SLOTS, 10)
      : null,
    agentMemoryMb: process.env.AGENT_MEMORY_MB
      ? parseInt(process.env.AGENT_MEMORY_MB, 10)
      : null,
    domain: process.env.DOMAIN ?? null,
    githubAppId: process.env.GITHUB_APP_ID ?? null,
    githubAppPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY ?? null,
    githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? null,
    githubAppInstallationId: process.env.GITHUB_APP_INSTALLATION_ID ?? null,
    discordBotToken: process.env.DISCORD_BOT_TOKEN ?? null,
    discordApplicationId: process.env.DISCORD_APPLICATION_ID ?? null,
    discordGuildId: process.env.DISCORD_GUILD_ID ?? null,
    reviewerGithubToken: process.env.REVIEWER_GH_TOKEN ?? null,
    autonomyEnabled: process.env.AUTONOMY_ENABLED === "true",
    autonomyAllowedAuthors: (process.env.AUTONOMY_ALLOWED_AUTHORS ?? "")
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean),
    discordFleetChannelId: process.env.DISCORD_FLEET_CHANNEL_ID ?? null,
    fleetHealthThresholds: {
      owedReviewStallMs: minutesEnvMs(
        process.env.OWED_REVIEW_STALL_MINUTES,
        DEFAULT_OWED_REVIEW_STALL_MS
      ),
      pickupWedgedMs: minutesEnvMs(
        process.env.PICKUP_WEDGED_MINUTES,
        DEFAULT_PICKUP_WEDGED_MS
      ),
      heartbeatStaleMs: minutesEnvMs(
        process.env.QUEUE_HEARTBEAT_STALE_MINUTES,
        DEFAULT_QUEUE_HEARTBEAT_STALE_MS
      ),
      occupancyDivergedMs: minutesEnvMs(
        process.env.OCCUPANCY_DIVERGED_MINUTES,
        DEFAULT_OCCUPANCY_DIVERGED_MS
      ),
    },
  };

  return _config;
}

/** Clear cached config so next getConfig() re-reads from env/filesystem */
export function resetConfig(): void {
  _config = null;
}

/** The pass kinds a Claude turn can run as (mirrors `tasks.kind`). */
export type AgentPassKind =
  | "interactive"
  | "implement"
  | "review"
  | "triage"
  | "repair";

/** Whether a pass carries the *ticket's own* work, and so answers to a ticket
 * directive. Review and triage do not: they read the work rather than doing
 * it, and the ticket chooses the model its work runs on, not the reviewer's.
 * Named once here because the model and effort resolvers both draw the line
 * and it must be the same line. */
function isWorkPassKind(kind: AgentPassKind): boolean {
  return kind !== "review" && kind !== "triage";
}

/**
 * Which model a turn of the given kind runs on (issues #74, #80, #166), and
 * the one place the three layers of that answer are ordered:
 *
 * 1. A ticket's `model:` directive — already normalised to a tier by the
 *    directive parser — wins, for the pass kinds that carry a run's tier
 *    (implement, repair and interactive). Review and triage keep their own
 *    (cheaper) tier regardless: the ticket chooses the model its *work* runs
 *    on, not the reviewer's.
 * 2. Then the UI override for this pass kind, if one is set (issue #166).
 * 3. Then the environment default — `AGENT_MODEL` as the base, with
 *    `AGENT_MODEL_REVIEW` / `AGENT_MODEL_TRIAGE` for the read-heavy passes.
 *    Null means "pass no `--model`": the CLI resolves the account default,
 *    exactly as before any of this was configurable.
 *
 * `overrides` is explicit rather than fetched here, and has no default, so a
 * new call site has to decide where it reads them from — the answer is
 * `getSettingsOverrides()` at the point of use, never a cached copy, because
 * `getConfig()` memoises and a UI override cannot ride on something that never
 * re-reads.
 */
export function resolveAgentModel(
  kind: AgentPassKind,
  config: AppConfig,
  ticketModel: string | null,
  overrides: SettingsOverrides
): string | null {
  if (isWorkPassKind(kind)) {
    // A tier or a legacy alias (`opus`) both resolve; anything else — a raw
    // model id previously recorded on the run row, say — names no tier and
    // falls through to the configured default rather than reaching `--model`.
    const ticketTier = normalizeModelTier(ticketModel);
    if (ticketTier !== null) return tierModelId(ticketTier);
  }
  return resolveModelTier(kind, config, overrides).model;
}

/**
 * Which reasoning-effort level a turn of the given kind runs at (issue #81),
 * the other half of the cost/quality dial alongside the model. `AGENT_EFFORT`
 * is the base — implement, repair and interactive passes all use it; the
 * read-heavy review and triage passes may name a lower level via
 * `AGENT_EFFORT_REVIEW` / `AGENT_EFFORT_TRIAGE` and otherwise fall back to it.
 * Null means "pass no `--effort`": the CLI resolves its own default, exactly
 * as before this was configurable — issue #81 deliberately ships no default
 * other than the CLI's own.
 *
 * `ticketEffort` is a per-ticket `effort:` directive, already clamped to the
 * allowlist by the directive parser. When present it overrides the base for
 * the pass kinds that carry a run's tier — implement, repair and interactive.
 * Review and triage keep their own (lower) level regardless: the ticket
 * chooses the effort its *work* runs at, not the reviewer's.
 */
export function resolveAgentEffort(
  kind: AgentPassKind,
  config: AppConfig = getConfig(),
  ticketEffort: string | null = null
): string | null {
  switch (kind) {
    case "review":
      return config.agentEffortReview ?? config.agentEffort;
    case "triage":
      return config.agentEffortTriage ?? config.agentEffort;
    default:
      return ticketEffort ?? config.agentEffort;
  }
}

// Platform repo URL — cloned into agent containers for estate-wide context
export const PLATFORM_REPO_URL = process.env.PLATFORM_REPO_URL || 'https://github.com/lennons301/platform.git';
