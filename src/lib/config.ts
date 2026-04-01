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

  if (!anthropicApiKey && !claudeCredentialsPath && !process.env.CLAUDE_CREDENTIALS_PATH) {
    console.warn(
      "Warning: No auth configured. Set ANTHROPIC_API_KEY, CLAUDE_CREDENTIALS_PATH, " +
        "or ensure ~/.claude/.credentials.json exists."
    );
  }
  if (!gitToken) {
    throw new Error("GIT_TOKEN is required");
  }

  // The host path is used to mount credentials into agent containers.
  // It comes directly from the env var — the app container itself may not
  // be able to see the file (it's a host path, not a container path).
  const claudeCredentialsHostPath = process.env.CLAUDE_CREDENTIALS_PATH ?? null;

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
    domain: process.env.DOMAIN ?? null,
    githubAppId: process.env.GITHUB_APP_ID ?? null,
    githubAppPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY ?? null,
    githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? null,
    githubAppInstallationId: process.env.GITHUB_APP_INSTALLATION_ID ?? null,
  };

  return _config;
}

/** Clear cached config so next getConfig() re-reads from env/filesystem */
export function resetConfig(): void {
  _config = null;
}

// Platform repo URL — cloned into agent containers for estate-wide context
export const PLATFORM_REPO_URL = process.env.PLATFORM_REPO_URL || 'https://github.com/lennons301/platform.git';
