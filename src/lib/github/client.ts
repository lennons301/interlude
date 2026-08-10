import { Octokit } from "octokit";
import jwt from "jsonwebtoken";
import { getConfig } from "../config";

let cachedToken: string | null = null;
let tokenExpiresAt = 0;
// The installation's granted repository permissions, captured from the same
// mint as the token (issue #62) — an unnarrowed installation token carries the
// installation's full grant, so there is nothing extra to fetch. Set alongside
// cachedToken and read via getInstallationPermissions.
let cachedPermissions: Record<string, string> = {};

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

/** Pure: is a cached token still safe to reuse (5-min margin before expiry)? */
export function isTokenFresh(expiresAt: number, now: number): boolean {
  return now < expiresAt - 5 * 60 * 1000;
}

/** Mint (or reuse a cached) GitHub App installation token for git + API use. */
export async function getInstallationToken(): Promise<string> {
  const config = getConfig();
  if (!config.githubAppId || !config.githubAppPrivateKey || !config.githubAppInstallationId) {
    throw new Error(
      "GitHub App required for git operations (set GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_APP_INSTALLATION_ID)"
    );
  }

  if (cachedToken && isTokenFresh(tokenExpiresAt, Date.now())) {
    return cachedToken;
  }

  const appJwt = createAppJwt();
  const appOctokit = new Octokit({ auth: appJwt });

  const { data: installation } = await appOctokit.rest.apps.createInstallationAccessToken({
    installation_id: parseInt(config.githubAppInstallationId, 10),
  });

  cachedToken = installation.token;
  tokenExpiresAt = new Date(installation.expires_at).getTime();
  cachedPermissions = (installation.permissions ?? {}) as Record<string, string>;

  return cachedToken;
}

export async function getOctokit(): Promise<Octokit> {
  const token = await getInstallationToken();
  return new Octokit({ auth: token });
}

/**
 * The repository permissions the App installation was granted, as an
 * `{ issues: "write", contents: "write", ... }` map (issue #62). Reuses the
 * cached mint from getInstallationToken — the installation token carries the
 * installation's full grant, so there is one round-trip and one minting path to
 * audit, not a second `apps.getInstallation` call per project. Preflight uses it
 * to confirm the App has the "Issues: write" every generation operation needs
 * (issue creation, comments, labels, dependency edges, sub-issues all live under
 * that one permission).
 */
export async function getInstallationPermissions(): Promise<
  Record<string, string>
> {
  await getInstallationToken();
  return cachedPermissions;
}
