import { Octokit } from "octokit";
import { getOctokit, isGitHubConfigured } from "./client";
import { getConfig } from "../config";

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
  /**
   * True when an existing open PR for the head was adopted rather than a new
   * one created — i.e. a retry continuing a previous attempt's branch (#72).
   */
  adopted?: boolean;
}

/**
 * The open PR whose head is `head` (GitHub allows at most one), or null. Used
 * to adopt a previous attempt's PR when a retry continues its branch (#72):
 * the head filter must be qualified with the repo owner, and same-repo agent
 * branches always share the repo owner.
 */
export async function findOpenPrForHead(
  owner: string,
  repo: string,
  head: string
): Promise<PrResult | null> {
  if (!isGitHubConfigured()) return null;

  try {
    const octokit = await getOctokit();
    const { data } = await octokit.rest.pulls.list({
      owner,
      repo,
      head: `${owner}:${head}`,
      state: "open",
      per_page: 1,
    });
    const pr = data[0];
    return pr ? { number: pr.number, url: pr.html_url } : null;
  } catch (err) {
    console.error(`[github] Failed to look up open PR for head "${head}":`, err);
    return null;
  }
}

/**
 * Ensure a draft PR exists for the branch, returning its number and URL.
 * Normally this creates one. On an autonomous retry that adopted a previous
 * attempt's branch (#72), the head already has an open PR and GitHub rejects a
 * second create with 422 — so fall back to adopting that PR rather than
 * dropping the retry's work: the caller must re-link it to mark it ready and
 * route it to review.
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
    const existing = await findOpenPrForHead(options.owner, options.repo, options.head);
    if (existing) {
      console.log(
        `[github] Adopting existing open PR #${existing.number} for head "${options.head}" (#72)`
      );
      return { ...existing, adopted: true };
    }
    console.error(`[github] Failed to create draft PR:`, err);
    return null;
  }
}

/**
 * Whether a PR can merge into its base cleanly. GitHub computes mergeability
 * lazily, so the first read after a push returns `unknown` (REST `mergeable:
 * null`) until the background check settles — callers re-poll rather than
 * treat `unknown` as a verdict (issue #54). `conflicting` is a settled "no".
 */
export type MergeableState = "mergeable" | "conflicting" | "unknown";

/**
 * The slice of PR state gate evaluation, run settlement and integration
 * (issue #54) depend on. Null on any API failure — the caller skips the PR
 * this sweep and retries on the next.
 */
export async function getPrState(
  owner: string,
  repo: string,
  prNumber: number
): Promise<{
  open: boolean;
  merged: boolean;
  autoMergeArmed: boolean;
  mergeable: MergeableState;
} | null> {
  if (!isGitHubConfigured()) return null;

  try {
    const octokit = await getOctokit();
    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    // REST `mergeable`: true = clean, false = conflicts, null = not yet
    // computed. Map null to `unknown` so a still-computing check is re-polled
    // rather than mistaken for a clean merge.
    const mergeable: MergeableState =
      pr.mergeable === true
        ? "mergeable"
        : pr.mergeable === false
          ? "conflicting"
          : "unknown";
    return {
      open: pr.state === "open",
      merged: pr.merged === true,
      autoMergeArmed: pr.auto_merge != null,
      mergeable,
    };
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
 * Disarm auto-merge on a PR. Only ever moves toward more human oversight:
 * a request-changes or escalate verdict (and an unparseable one) disarms
 * before anything else happens, so nothing can land mid-decision.
 */
export async function disarmAutoMerge(
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

    // Already disarmed (or landed by someone else's hand) — nothing to do.
    if (pr.auto_merge == null) return true;

    await octokit.graphql(
      `
      mutation($id: ID!) {
        disablePullRequestAutoMerge(input: { pullRequestId: $id }) {
          pullRequest { id }
        }
      }
    `,
      { id: pr.node_id }
    );
    return true;
  } catch (err) {
    console.error(`[github] Failed to disarm auto-merge on PR #${prNumber}:`, err);
    return false;
  }
}

/**
 * Post a PR review as the reviewer machine account. This is the one place
 * the reviewer identity is exercised, and it runs in the orchestrator with
 * a token read from config at call time — the PAT never enters a container,
 * so no agent process ever holds the identity that can approve agent work.
 */
export async function postReviewAsReviewer(
  owner: string,
  repo: string,
  prNumber: number,
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  body: string
): Promise<boolean> {
  const token = getConfig().reviewerGithubToken;
  if (!token) {
    console.error(
      `[github] REVIEWER_GH_TOKEN not configured — cannot post ${event} review on PR #${prNumber}`
    );
    return false;
  }

  try {
    const reviewer = new Octokit({ auth: token });
    await reviewer.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      event,
      body,
    });
    return true;
  } catch (err) {
    console.error(`[github] Failed to post ${event} review on PR #${prNumber}:`, err);
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
