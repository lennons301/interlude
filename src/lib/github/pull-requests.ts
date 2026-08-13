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
 * The head commit's check rollup (issue #130). Textual mergeability says
 * nothing about whether the branch compiles: a clean merge that breaks the
 * build is the normal way a deleted API meets a new caller added on the
 * default branch, and GitHub reports exactly that as `mergeable` + a red
 * rollup. Distinguished so the loop can repair red CI instead of parking
 * forever beside it.
 *
 * - `failing` — at least one check has settled on a failure. Actionable now.
 * - `pending` — nothing has failed yet but something is still running.
 * - `passing` — every context settled green (skipped/neutral included).
 * - `none` — the head commit has no checks at all (a repo without CI).
 * - `unknown` — the rollup could not be read. Like `unknown` mergeability,
 *   never a verdict: the caller re-polls next sweep.
 */
export type CheckRollupState = "passing" | "failing" | "pending" | "none" | "unknown";

/** A failed check, named for the repair prompt and the needs-you card. */
export interface FailedCheck {
  name: string;
  /** Where a human (or the repair pass) reads the failure; null if GitHub
   * gave no URL for the context. */
  url: string | null;
}

export interface PrCheckRollup {
  state: CheckRollupState;
  /** Empty unless `state` is `failing`. */
  failed: FailedCheck[];
}

/** CheckRun conclusions that are a settled failure — GitHub's own rollup
 * semantics, which is what actually blocks the merge. SKIPPED and NEUTRAL are
 * not failures (the motivating PR had a deliberately skipped Build job).
 * ACTION_REQUIRED and CANCELLED are: both leave a required check unsatisfied, so
 * the PR is stuck, and a bounded repair that cannot fix it ends in escalation to
 * a human — which is the right destination for a check only a human can clear. */
const FAILING_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
]);

/** StatusContext states that are a settled failure — the Vercel deployment
 * that motivated this ticket reports here, not as a CheckRun. */
const FAILING_STATUS_STATES = new Set(["FAILURE", "ERROR"]);

interface RollupContext {
  __typename?: string;
  /** CheckRun */
  name?: string;
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string | null;
  /** StatusContext */
  context?: string;
  state?: string;
  targetUrl?: string | null;
}

/**
 * Fold the rollup's contexts into one state plus the failures worth naming.
 * A settled failure outranks a straggler still running: a failed required
 * check does not un-fail, so waiting for the rest would only delay the repair.
 */
function foldRollup(contexts: RollupContext[]): PrCheckRollup {
  const failed: FailedCheck[] = [];
  let pending = false;

  for (const ctx of contexts) {
    const isStatus = ctx.__typename === "StatusContext" || ctx.context != null;
    if (isStatus) {
      const state = ctx.state ?? "";
      if (FAILING_STATUS_STATES.has(state)) {
        failed.push({ name: ctx.context ?? "status", url: ctx.targetUrl ?? null });
      } else if (state !== "SUCCESS") {
        // PENDING / EXPECTED — a required context that has not reported yet.
        pending = true;
      }
      continue;
    }
    // A CheckRun is only judged once it has completed; anything else (queued,
    // in progress, waiting on a deployment gate) is still pending. A completed
    // run with no conclusion is unreadable rather than green, so it waits too.
    if (ctx.status !== "COMPLETED") {
      pending = true;
    } else if (ctx.conclusion != null && FAILING_CONCLUSIONS.has(ctx.conclusion)) {
      failed.push({ name: ctx.name ?? "check", url: ctx.detailsUrl ?? null });
    } else if (ctx.conclusion == null) {
      pending = true;
    }
  }

  if (failed.length > 0) return { state: "failing", failed };
  if (pending) return { state: "pending", failed: [] };
  if (contexts.length === 0) return { state: "none", failed: [] };
  return { state: "passing", failed: [] };
}

const ROLLUP_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun { name status conclusion detailsUrl }
                    ... on StatusContext { context state targetUrl }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * The head commit's check rollup, in one GraphQL call: `statusCheckRollup`
 * covers CheckRuns and StatusContexts together, where the REST equivalent
 * needs two paginated reads. A read failure is `unknown`, never a verdict —
 * the caller re-polls rather than acting on a rollup it could not see.
 */
async function getCheckRollup(
  owner: string,
  repo: string,
  prNumber: number
): Promise<PrCheckRollup> {
  try {
    const octokit = await getOctokit();
    const data = (await octokit.graphql(ROLLUP_QUERY, {
      owner,
      repo,
      number: prNumber,
    })) as {
      repository?: {
        pullRequest?: {
          commits?: {
            nodes?: Array<{
              commit?: {
                statusCheckRollup?: { contexts?: { nodes?: RollupContext[] } } | null;
              };
            }>;
          };
        };
      };
    };
    const rollup =
      data.repository?.pullRequest?.commits?.nodes?.[0]?.commit?.statusCheckRollup;
    // No rollup at all: the head commit has no checks (a repo without CI).
    if (!rollup) return { state: "none", failed: [] };
    return foldRollup(rollup.contexts?.nodes ?? []);
  } catch (err) {
    console.error(`[github] Failed to read the check rollup of PR #${prNumber}:`, err);
    return { state: "unknown", failed: [] };
  }
}

/**
 * The slice of PR state gate evaluation, run settlement, integration
 * (issue #54) and CI repair (issue #130) depend on. Null on any API failure —
 * the caller skips the PR this sweep and retries on the next. The head SHA is
 * returned alongside the rollup so callers can tell one head's checks from
 * another's (a new push starts its own observation).
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
  /** The PR's head commit — the SHA the rollup below belongs to */
  headSha: string;
  checks: PrCheckRollup;
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
      headSha: pr.head.sha,
      checks: await getCheckRollup(owner, repo, prNumber),
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
