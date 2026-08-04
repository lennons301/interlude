import { DEFAULT_ATTEMPT_BUDGET_USD } from "./orchestrator/autonomy/budgets";

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

/**
 * Which model a turn of the given kind runs on (issue #74). `AGENT_MODEL` is
 * the base — implement, repair and interactive passes all use it; review and
 * triage may name a cheaper tier via `AGENT_MODEL_REVIEW` / `AGENT_MODEL_TRIAGE`
 * and otherwise fall back to it. Null means "pass no `--model`": the CLI
 * resolves the account default, exactly as before this was configurable.
 *
 * `ticketModel` is a per-ticket `model:` directive (issue #80), already
 * clamped to the allowlist by the directive parser. When present it overrides
 * the base for the pass kinds that carry a run's tier — implement, repair and
 * interactive. Review and triage keep their own (cheaper) tier regardless: the
 * ticket chooses the model its *work* runs on, not the reviewer's.
 */
export function resolveAgentModel(
  kind: AgentPassKind,
  config: AppConfig = getConfig(),
  ticketModel: string | null = null
): string | null {
  switch (kind) {
    case "review":
      return config.agentModelReview ?? config.agentModel;
    case "triage":
      return config.agentModelTriage ?? config.agentModel;
    default:
      return ticketModel ?? config.agentModel;
  }
}

// Platform repo URL — cloned into agent containers for estate-wide context
export const PLATFORM_REPO_URL = process.env.PLATFORM_REPO_URL || 'https://github.com/lennons301/platform.git';
