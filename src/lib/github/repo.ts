/**
 * Extract { owner, repo } from a GitHub git URL (https or scp-style ssh).
 * Returns null for non-GitHub hosts or unparseable input.
 */
export function parseRepoFromGitUrl(
  gitUrl: string
): { owner: string; repo: string } | null {
  if (!gitUrl) return null;

  // scp-style: git@github.com:owner/repo(.git)
  const scp = gitUrl.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (scp) return { owner: scp[1], repo: scp[2] };

  // https: https://github.com/owner/repo(.git)(/)
  const https = gitUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (https) return { owner: https[1], repo: https[2] };

  return null;
}
