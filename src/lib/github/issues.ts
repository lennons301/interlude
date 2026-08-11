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

/** An open issue reduced to what the session issue-picker needs (issue #64). */
export interface OpenIssue {
  number: number;
  title: string;
  /** Full `owner/repo#n` ref — what a session's `sessionIssue` anchor stores. */
  ref: string;
}

/**
 * List a repo's open issues for the mobile session issue-picker (issue #64).
 * `repoFullName` is the project's `owner/repo`. Pull requests are excluded —
 * `listForRepo` returns them alongside issues, but a session anchors to an
 * issue, never a PR. Returns an empty list when GitHub is unconfigured, the
 * repo is unparseable, or the read fails, so the picker degrades to
 * freeform-only rather than blocking session creation. Capped at the first
 * page (100, newest first) — the picker surfaces recent issues, not the whole
 * backlog; anything older is still reachable by typing a freeform agenda.
 */
export async function listOpenIssues(repoFullName: string): Promise<OpenIssue[]> {
  if (!isGitHubConfigured()) return [];

  const [owner, repo] = (repoFullName ?? "").split("/");
  if (!owner || !repo) return [];

  try {
    const octokit = await getOctokit();
    const { data: issues } = await octokit.rest.issues.listForRepo({
      owner,
      repo,
      state: "open",
      per_page: 100,
    });
    return issues
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        ref: `${repoFullName}#${issue.number}`,
      }));
  } catch (err) {
    console.error(`[github] Failed to list open issues for ${repoFullName}:`, err);
    return [];
  }
}

/** One issue comment, reduced to what a retry prompt needs (issue #73). */
export interface IssueComment {
  /** GitHub login of the author ("" if the API omitted it) */
  author: string;
  body: string;
}

/**
 * Which of an issue's comments (oldest-first) a retry carries as history: the
 * most-recent `recentTail` for context, plus every human-authored comment
 * however old. Lifecycle chatter — the executor's own claim/PR/complete
 * comments — is posted as a bot and can push an early human comment past the
 * tail, but a human's guidance ("the fix is X") must still reach the next
 * attempt (issue #73), so human comments are floored in regardless of depth.
 * Order is preserved and a comment kept by both rules appears once. Pure.
 */
export function selectRetryComments<T extends { authorIsBot: boolean }>(
  comments: T[],
  recentTail: number
): T[] {
  const tailCutoff = comments.length - recentTail;
  return comments.filter((c, i) => i >= tailCutoff || !c.authorIsBot);
}

/**
 * The comments a retry's prompt carries as history (issue #73) — the executor's
 * own recent attempt reports plus any human guidance added between attempts,
 * oldest-first. Returns an empty list when GitHub is unconfigured or the read
 * fails, so a retry prompt degrades to no history rather than blocking the
 * claim. `recentTail` bounds the always-kept recent slice; human comments are
 * kept on top of it (see selectRetryComments).
 */
export async function listRecentIssueComments(
  issueRef: string,
  recentTail: number
): Promise<IssueComment[]> {
  if (!isGitHubConfigured()) return [];

  const parsed = parseIssueRef(issueRef);
  if (!parsed) return [];

  try {
    const octokit = await getOctokit();
    // Comments come oldest-first; paginate the full history so both the tail
    // and the human-comment floor see the genuinely complete thread.
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner: parsed.owner,
      repo: parsed.repo,
      issue_number: parsed.number,
      per_page: 100,
    });
    const shaped = comments.map((c) => ({
      author: c.user?.login ?? "",
      body: c.body ?? "",
      authorIsBot: c.user?.type === "Bot",
    }));
    return selectRetryComments(shaped, recentTail).map(({ author, body }) => ({
      author,
      body,
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
