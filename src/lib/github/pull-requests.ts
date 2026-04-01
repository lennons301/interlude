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
