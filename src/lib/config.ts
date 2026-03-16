import path from "path";
import fs from "fs";

export interface AppConfig {
  /** Anthropic API key (optional if using OAuth credentials) */
  anthropicApiKey: string | null;
  /** Path to Claude OAuth credentials file inside this container */
  claudeCredentialsPath: string | null;
  /** Host path for mounting credentials into agent containers */
  claudeCredentialsHostPath: string | null;
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

  // Find Claude credentials file — check the container mount path first,
  // then fall back to CLAUDE_CREDENTIALS_PATH or $HOME default
  const candidatePaths = [
    "/home/node/.claude/.credentials.json",
    process.env.CLAUDE_CREDENTIALS_PATH,
    path.join(process.env.HOME ?? "/root", ".claude", ".credentials.json"),
  ].filter(Boolean) as string[];

  const credentialsPath = candidatePaths.find((p) => fs.existsSync(p)) ?? candidatePaths[0];

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

  // The host path is what docker-compose used to mount into this container
  // It's the original CLAUDE_CREDENTIALS_PATH env var (set to the host path in .env)
  const claudeCredentialsHostPath = claudeCredentialsPath
    ? (process.env.CLAUDE_CREDENTIALS_PATH ?? null)
    : null;

  _config = {
    anthropicApiKey,
    claudeCredentialsPath,
    claudeCredentialsHostPath,
    gitToken,
    gitUserName: process.env.GIT_USER_NAME ?? "Interlude Agent",
    gitUserEmail: process.env.GIT_USER_EMAIL ?? "agent@interlude.dev",
    keepContainers: process.env.KEEP_CONTAINERS === "true",
    maxTurns: parseInt(process.env.MAX_TURNS ?? "50", 10),
    maxBudgetUsd: parseFloat(process.env.MAX_BUDGET_USD ?? "5.00"),
  };

  return _config;
}
