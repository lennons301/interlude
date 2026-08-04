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

/** One issue comment, reduced to what a retry prompt needs (issue #73). */
export interface IssueComment {
  /** GitHub login of the author ("" if the API omitted it) */
  author: string;
  body: string;
}

/**
 * The tail of an issue's comments, oldest-first — the executor's own attempt
 * reports plus any human guidance added between attempts (issue #73). Returns
 * at most `limit` comments, and an empty list when GitHub is unconfigured or
 * the read fails, so a retry prompt degrades to no history rather than
 * blocking the claim.
 */
export async function listRecentIssueComments(
  issueRef: string,
  limit: number
): Promise<IssueComment[]> {
  if (!isGitHubConfigured()) return [];

  const parsed = parseIssueRef(issueRef);
  if (!parsed) return [];

  try {
    const octokit = await getOctokit();
    // Comments come oldest-first; paginate the full history so the tail is the
    // genuinely most-recent slice even on a comment-heavy issue.
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner: parsed.owner,
      repo: parsed.repo,
      issue_number: parsed.number,
      per_page: 100,
    });
    return comments.slice(-limit).map((c) => ({
      author: c.user?.login ?? "",
      body: c.body ?? "",
    }));
  } catch (err) {
    console.error(`[github] Failed to list comments on ${issueRef}:`, err);
    return [];
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
