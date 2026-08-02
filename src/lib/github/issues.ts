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
 * Returns false when the comment did not land, for callers whose ordering
 * depends on it; most callers fire and forget.
 */
export async function commentOnIssue(
  issueRef: string,
  body: string
): Promise<boolean> {
  if (!isGitHubConfigured()) return false;

  const parsed = parseIssueRef(issueRef);
  if (!parsed) return false;

  try {
    const octokit = await getOctokit();
    await octokit.rest.issues.createComment({
      owner: parsed.owner,
      repo: parsed.repo,
      issue_number: parsed.number,
      body,
    });
    return true;
  } catch (err) {
    console.error(`[github] Failed to comment on ${issueRef}:`, err);
    return false;
  }
}

/**
 * Add a label to an issue. Returns false on failure so callers can retry on
 * a later sweep; adding an already-present label is a GitHub no-op.
 */
export async function addLabelToIssue(issueRef: string, label: string): Promise<boolean> {
  if (!isGitHubConfigured()) return false;

  const parsed = parseIssueRef(issueRef);
  if (!parsed) return false;

  try {
    const octokit = await getOctokit();
    await octokit.rest.issues.addLabels({
      owner: parsed.owner,
      repo: parsed.repo,
      issue_number: parsed.number,
      labels: [label],
    });
    return true;
  } catch (err) {
    console.error(`[github] Failed to label ${issueRef} with "${label}":`, err);
    return false;
  }
}

/**
 * Remove a label from an issue. A label that is already absent counts as
 * removed (404), so retried removals stay idempotent.
 */
export async function removeLabelFromIssue(issueRef: string, label: string): Promise<boolean> {
  if (!isGitHubConfigured()) return false;

  const parsed = parseIssueRef(issueRef);
  if (!parsed) return false;

  try {
    const octokit = await getOctokit();
    await octokit.rest.issues.removeLabel({
      owner: parsed.owner,
      repo: parsed.repo,
      issue_number: parsed.number,
      name: label,
    });
    return true;
  } catch (err) {
    if ((err as { status?: number }).status === 404) return true;
    console.error(`[github] Failed to remove label "${label}" from ${issueRef}:`, err);
    return false;
  }
}
