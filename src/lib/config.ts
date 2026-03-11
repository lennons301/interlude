import path from "path";
import fs from "fs";

export interface AppConfig {
  /** Anthropic API key (optional if using OAuth credentials) */
  anthropicApiKey: string | null;
  /** Path to Claude OAuth credentials file (e.g. ~/.claude/.credentials.json) */
  claudeCredentialsPath: string | null;
  gitToken: string;
  gitUserName: string;
  gitUserEmail: string;
  keepContainers: boolean;
  /** Max agentic turns per task (default: 50) */
  maxTurns: number;
  /** Max budget in USD per task (default: 5.00) */
  maxBudgetUsd: number;
}

let _config: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (_config) return _config;

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY ?? null;
  const gitToken = process.env.GIT_TOKEN;

  // Find Claude credentials file
  const credentialsPath =
    process.env.CLAUDE_CREDENTIALS_PATH ??
    path.join(process.env.HOME ?? "/root", ".claude", ".credentials.json");

  const claudeCredentialsPath =
    fs.existsSync(credentialsPath) ? credentialsPath : null;

  if (!anthropicApiKey && !claudeCredentialsPath) {
    throw new Error(
      "Either ANTHROPIC_API_KEY or Claude OAuth credentials (~/.claude/.credentials.json) is required"
    );
  }
  if (!gitToken) {
    throw new Error("GIT_TOKEN is required");
  }

  _config = {
    anthropicApiKey,
    claudeCredentialsPath,
    gitToken,
    gitUserName: process.env.GIT_USER_NAME ?? "Interlude Agent",
    gitUserEmail: process.env.GIT_USER_EMAIL ?? "agent@interlude.dev",
    keepContainers: process.env.KEEP_CONTAINERS === "true",
    maxTurns: parseInt(process.env.MAX_TURNS ?? "50", 10),
    maxBudgetUsd: parseFloat(process.env.MAX_BUDGET_USD ?? "5.00"),
  };

  return _config;
}
