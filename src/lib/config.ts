export interface AppConfig {
  anthropicApiKey: string;
  gitToken: string;
  gitUserName: string;
  gitUserEmail: string;
  keepContainers: boolean;
}

let _config: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (_config) return _config;

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const gitToken = process.env.GIT_TOKEN;

  if (!anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is required");
  }
  if (!gitToken) {
    throw new Error("GIT_TOKEN is required");
  }

  _config = {
    anthropicApiKey,
    gitToken,
    gitUserName: process.env.GIT_USER_NAME ?? "Interlude Agent",
    gitUserEmail: process.env.GIT_USER_EMAIL ?? "agent@interlude.dev",
    keepContainers: process.env.KEEP_CONTAINERS === "true",
  };

  return _config;
}
