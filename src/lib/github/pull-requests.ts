import { getOctokit, isGitHubConfigured } from "./client";

interface CreatePrOptions {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base?: string;
}

interface PrResult {
  number: number;
  url: string;
}

/**
 * Create a draft PR. Returns the PR number and URL.
 */
export async function createDraftPr(options: CreatePrOptions): Promise<PrResult | null> {
  if (!isGitHubConfigured()) return null;

  try {
    const octokit = await getOctokit();

    let base = options.base;
    if (!base) {
      const { data: repo } = await octokit.rest.repos.get({
        owner: options.owner,
        repo: options.repo,
      });
      base = repo.default_branch;
    }

    const { data: pr } = await octokit.rest.pulls.create({
      owner: options.owner,
      repo: options.repo,
      title: options.title,
      body: options.body,
      head: options.head,
      base,
      draft: true,
    });

    return { number: pr.number, url: pr.html_url };
  } catch (err) {
    console.error(`[github] Failed to create draft PR:`, err);
    return null;
  }
}

/**
 * The slice of PR state gate evaluation depends on. Null on any API failure
 * — the caller skips the PR this sweep and retries on the next.
 */
export async function getPrState(
  owner: string,
  repo: string,
  prNumber: number
): Promise<{ open: boolean; autoMergeArmed: boolean } | null> {
  if (!isGitHubConfigured()) return null;

  try {
    const octokit = await getOctokit();
    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    return { open: pr.state === "open", autoMergeArmed: pr.auto_merge != null };
  } catch (err) {
    console.error(`[github] Failed to read PR #${prNumber} state:`, err);
    return null;
  }
}

/**
 * Every path a PR changes, from the GitHub API. Renames contribute both
 * sides: a gated file moved away still deserves its gate. Null on failure
 * so gate evaluation can fail closed rather than evaluate a partial list.
 */
export async function listChangedFiles(
  owner: string,
  repo: string,
  prNumber: number
): Promise<string[] | null> {
  if (!isGitHubConfigured()) return null;

  try {
    const octokit = await getOctokit();
    const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });
    const paths = new Set<string>();
    for (const file of files) {
      paths.add(file.filename);
      if (file.previous_filename) paths.add(file.previous_filename);
    }
    return [...paths];
  } catch (err) {
    console.error(`[github] Failed to list files of PR #${prNumber}:`, err);
    return null;
  }
}

/**
 * Add a label to a PR (PRs are issues to the labels API).
 */
export async function labelPr(
  owner: string,
  repo: string,
  prNumber: number,
  label: string
): Promise<boolean> {
  if (!isGitHubConfigured()) return false;

  try {
    const octokit = await getOctokit();
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: prNumber,
      labels: [label],
    });
    return true;
  } catch (err) {
    console.error(`[github] Failed to label PR #${prNumber} with "${label}":`, err);
    return false;
  }
}

/**
 * Arm auto-merge (squash) on a PR. With branch protection in place the PR
 * merges only once its required approval lands — arming after the final
 * push means that approval will be the reviewer's, not a stale one.
 */
export async function armAutoMergeSquash(
  owner: string,
  repo: string,
  prNumber: number
): Promise<boolean> {
  if (!isGitHubConfigured()) return false;

  try {
    const octokit = await getOctokit();
    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    await octokit.graphql(
      `
      mutation($id: ID!) {
        enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH }) {
          pullRequest { id }
        }
      }
    `,
      { id: pr.node_id }
    );
    return true;
  } catch (err) {
    console.error(`[github] Failed to arm auto-merge on PR #${prNumber}:`, err);
    return false;
  }
}

/**
 * Mark a draft PR as ready for review.
 */
export async function markPrReady(
  owner: string,
  repo: string,
  prNumber: number
): Promise<void> {
  if (!isGitHubConfigured()) return;

  try {
    const octokit = await getOctokit();

    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    if (!pr.draft) return;

    await octokit.graphql(`
      mutation($id: ID!) {
        markPullRequestReadyForReview(input: { pullRequestId: $id }) {
          pullRequest { id }
        }
      }
    `, { id: pr.node_id });
  } catch (err) {
    console.error(`[github] Failed to mark PR #${prNumber} ready:`, err);
  }
}
