import { Octokit } from "octokit";
import jwt from "jsonwebtoken";
import { getConfig } from "../config";

let cachedOctokit: Octokit | null = null;
let tokenExpiresAt = 0;

function createAppJwt(): string {
  const config = getConfig();
  if (!config.githubAppId || !config.githubAppPrivateKey) {
    throw new Error("GitHub App not configured");
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60,
    exp: now + 600,
    iss: config.githubAppId,
  };

  return jwt.sign(payload, config.githubAppPrivateKey, { algorithm: "RS256" });
}

export function isGitHubConfigured(): boolean {
  const config = getConfig();
  return !!(
    config.githubAppId &&
    config.githubAppPrivateKey &&
    config.githubWebhookSecret &&
    config.githubAppInstallationId
  );
}

export async function getOctokit(): Promise<Octokit> {
  const config = getConfig();
  if (!config.githubAppInstallationId) {
    throw new Error("GitHub App installation ID not configured");
  }

  if (cachedOctokit && Date.now() < tokenExpiresAt - 5 * 60 * 1000) {
    return cachedOctokit;
  }

  const appJwt = createAppJwt();
  const appOctokit = new Octokit({ auth: appJwt });

  const { data: installation } = await appOctokit.rest.apps.createInstallationAccessToken({
    installation_id: parseInt(config.githubAppInstallationId, 10),
  });

  cachedOctokit = new Octokit({ auth: installation.token });
  tokenExpiresAt = new Date(installation.expires_at).getTime();

  return cachedOctokit;
}
