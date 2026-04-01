import { getOctokit, isGitHubConfigured } from "./client";

/**
 * Parse "owner/repo#123" into parts. Returns null if format doesn't match.
 */
export function parseIssueRef(ref: string): { owner: string; repo: string; number: number } | null {
  const match = ref.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
}

/**
 * Post a comment on a GitHub issue. No-op if GitHub is not configured.
 */
export async function commentOnIssue(
  issueRef: string,
  body: string
): Promise<void> {
  if (!isGitHubConfigured()) return;

  const parsed = parseIssueRef(issueRef);
  if (!parsed) return;

  try {
    const octokit = await getOctokit();
    await octokit.rest.issues.createComment({
      owner: parsed.owner,
      repo: parsed.repo,
      issue_number: parsed.number,
      body,
    });
  } catch (err) {
    console.error(`[github] Failed to comment on ${issueRef}:`, err);
  }
}
