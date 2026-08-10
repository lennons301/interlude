/**
 * Autonomy preflight (issue #26) — the deterministic answer to "is this repo
 * safe to run unattended against?". A project must pass every check before the
 * reducer will claim any of its tickets (decide.ts fails closed on a
 * never-checked or failing preflight), so this is the gate that turns the loop
 * on for a repo.
 *
 * The mapping from check results to a stored status + human-readable reason is
 * a pure function (`evaluatePreflight`) so it is table-testable with no I/O;
 * `computePreflight` is the thin GitHub-API shell that gathers the results.
 * The reason names what is missing, which is what the dashboard's "needs you"
 * bucket and the pause log surface to the owner.
 *
 * The access-failure path is deliberately fine-grained (issue #70): a repo the
 * App can't reach, an endpoint the App lacks permission for, and a genuinely
 * unprotected branch are three different owner actions, so they get three
 * distinct reasons rather than collapsing into a misleading "no branch
 * protection". We also never guess the default branch — a wrong guess would
 * 404 the protection probe and mis-report a configured repo as unprotected.
 */

import { db } from "@/db";
import { projects } from "@/db/schema";
import { eq } from "drizzle-orm";
import { Octokit } from "octokit";
import { getConfig } from "../../config";
import { getInstallationPermissions, getOctokit, isGitHubConfigured } from "../../github/client";
import { HUMAN_SIGNOFF_LABEL } from "./gates";

/**
 * Outcome of probing branch protection on the default branch. Three states
 * because each needs a different owner action: turn protection on
 * (`unprotected`), grant the App the "Administration: read" permission the
 * endpoint requires (`forbidden`, a 403 "Resource not accessible by
 * integration"), or nothing (`protected`).
 */
export type BranchProtectionStatus = "protected" | "unprotected" | "forbidden";

/**
 * Outcome of the App-token repos.get. `inaccessible` (a 404/403) is the repo
 * not being in the App installation — a specific owner fix — whereas
 * `unreachable` is a transient/unknown GitHub error that no config change would
 * fix. Keeping them distinct stops a network blip from telling the owner to
 * "add the repo to the installation" when nothing is actually misconfigured
 * (issue #70).
 */
export type RepoAccess = "accessible" | "inaccessible" | "unreachable";

/** Every requirement autonomy depends on. */
export interface PreflightChecks {
  /** Project has both a gitUrl and an owner/repo githubRepo */
  repoConfigured: boolean;
  /** owner/repo, named in the reasons that must point the owner at a repo */
  repo: string;
  /** Whether the App installation can reach the repo at all (repos.get) */
  repoAccess: RepoAccess;
  /** Branch-protection probe on the repo's real default branch */
  branchProtection: BranchProtectionStatus;
  /** The reviewer machine account is a collaborator on the repo */
  reviewerIsCollaborator: boolean;
  /** The `human-signoff` label exists so gated PRs can be labelled */
  signoffLabelExists: boolean;
  /**
   * The App installation grants "Issues: write" (issue #62). It is the one
   * permission every generation skill relies on — issue creation, comments,
   * labels, native dependency edges, and sub-issue creation all require it — so
   * a single check covers everything a generation session does via `gh`.
   */
  issuesWritable: boolean;
}

export interface PreflightResult {
  status: "passing" | "failing";
  /** null when passing; names what is missing when failing */
  reason: string | null;
}

/** How often the periodic refresh re-checks autonomy-enabled projects. */
const PREFLIGHT_REFRESH_INTERVAL_MS = 5 * 60_000;

/**
 * Pure: map gathered checks to a stored status and a reason that names what is
 * missing. `repoConfigured` and `repoAccess` are prerequisites — without them
 * the remaining checks cannot even be gathered, so a failure there
 * short-circuits to a single clear reason rather than a misleading list. The
 * rest are independent and accumulate, so the owner fixes everything in one
 * pass. A branch-protection `forbidden` names the missing App permission, not a
 * missing protection, so the owner grants the right thing (issue #70).
 */
export function evaluatePreflight(checks: PreflightChecks): PreflightResult {
  if (!checks.repoConfigured) {
    return { status: "failing", reason: "no GitHub repo configured (needs gitUrl and githubRepo)" };
  }
  if (checks.repoAccess === "inaccessible") {
    return {
      status: "failing",
      reason: `the GitHub App cannot access ${checks.repo} — add it to the App installation`,
    };
  }
  if (checks.repoAccess === "unreachable") {
    return {
      status: "failing",
      reason: `could not reach GitHub to check ${checks.repo} — will retry`,
    };
  }

  const missing: string[] = [];
  if (checks.branchProtection === "forbidden") {
    missing.push(
      `the GitHub App lacks the "Administration: read" permission needed to read branch protection on ${checks.repo}`
    );
  } else if (checks.branchProtection === "unprotected") {
    missing.push("no branch protection on the default branch");
  }
  if (!checks.reviewerIsCollaborator) missing.push("the reviewer account is not a collaborator");
  if (!checks.signoffLabelExists) missing.push(`the "${HUMAN_SIGNOFF_LABEL}" label is missing`);
  if (!checks.issuesWritable)
    missing.push(
      'the GitHub App lacks the "Issues: write" permission generation sessions need (issue creation, comments, labels, dependency edges, sub-issues)'
    );

  return missing.length === 0
    ? { status: "passing", reason: null }
    : { status: "failing", reason: missing.join("; ") };
}

type ProjectRow = typeof projects.$inferSelect;

/** The HTTP status of an Octokit error, if it carries one. */
function httpStatus(err: unknown): number | undefined {
  return typeof err === "object" && err !== null ? (err as { status?: number }).status : undefined;
}

/** Did an Octokit call fail with an HTTP 404 (as opposed to a real error)? */
function isNotFound(err: unknown): boolean {
  return httpStatus(err) === 404;
}

/** A 403 — the App is authenticated but lacks the permission for this endpoint. */
function isForbidden(err: unknown): boolean {
  return httpStatus(err) === 403;
}

/**
 * Run one boolean check against the GitHub API: a 404 means the thing genuinely
 * isn't there (check false); any other error is a real failure worth logging,
 * and still resolves false so preflight fails closed rather than passing on a
 * transient blip.
 */
async function apiCheck(label: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err) {
    if (!isNotFound(err)) {
      console.error(`[preflight] ${label} failed:`, err);
    }
    return false;
  }
}

/**
 * Probe branch protection on the default branch, keeping the three outcomes
 * distinct (issue #70): a 403 "Resource not accessible by integration" means
 * the App is missing the "Administration: read" permission the endpoint needs,
 * a 404 means the branch is genuinely unprotected, and success means protected.
 * Any other (transient) error fails closed as `unprotected` but is logged, so
 * the "no branch protection" reason it produces can be traced to its real cause.
 */
async function probeBranchProtection(
  octokit: Awaited<ReturnType<typeof getOctokit>>,
  owner: string,
  repo: string,
  branch: string
): Promise<BranchProtectionStatus> {
  try {
    await octokit.rest.repos.getBranchProtection({ owner, repo, branch });
    return "protected";
  } catch (err) {
    if (isForbidden(err)) return "forbidden";
    if (isNotFound(err)) return "unprotected";
    console.error(`[preflight] getBranchProtection ${owner}/${repo} failed:`, err);
    return "unprotected";
  }
}

/** Resolve the reviewer machine account's login from REVIEWER_GH_TOKEN. */
async function reviewerLogin(): Promise<string | null> {
  const token = getConfig().reviewerGithubToken;
  if (!token) return null;
  try {
    const reviewer = new Octokit({ auth: token });
    const { data } = await reviewer.rest.users.getAuthenticated();
    return data.login;
  } catch (err) {
    console.error("[preflight] Could not resolve reviewer login from REVIEWER_GH_TOKEN:", err);
    return null;
  }
}

/** Is the reviewer machine account a collaborator on the repo? */
async function isReviewerCollaborator(
  octokit: Awaited<ReturnType<typeof getOctokit>>,
  owner: string,
  repo: string
): Promise<boolean> {
  const login = await reviewerLogin();
  if (!login) return false;
  return apiCheck(`checkCollaborator ${owner}/${repo}`, () =>
    octokit.rest.repos.checkCollaborator({ owner, repo, username: login })
  );
}

/**
 * Does the App installation grant "Issues: write"? Read off the installation's
 * declared permissions (issue #62) rather than probed by mutating an issue —
 * the declared grant is the deterministic, side-effect-free source of truth.
 * Any failure to read it fails closed as `false`, so an under-permissioned or
 * unreachable App never reads as ready for a generation session.
 */
async function hasIssuesWrite(): Promise<boolean> {
  try {
    const permissions = await getInstallationPermissions();
    return permissions.issues === "write";
  } catch (err) {
    console.error("[preflight] Could not read App installation permissions:", err);
    return false;
  }
}

/**
 * Gather the autonomy checks for a project via the GitHub API. Every network
 * failure resolves to the fail-closed value so an unreachable or
 * under-permissioned repo never reads as ready. Downstream checks are only
 * attempted once the App is confirmed to reach the repo, since they all need
 * the installation token — and only against the repo's real default branch.
 */
export async function computePreflight(project: ProjectRow): Promise<PreflightResult> {
  const repoConfigured = !!project.gitUrl && !!project.githubRepo;
  const [owner, repo] = (project.githubRepo ?? "").split("/");
  if (!repoConfigured || !owner || !repo) {
    return evaluatePreflight({
      repoConfigured: false,
      repo: project.githubRepo ?? "",
      repoAccess: "inaccessible",
      branchProtection: "unprotected",
      reviewerIsCollaborator: false,
      signoffLabelExists: false,
      issuesWritable: false,
    });
  }

  const repoLabel = `${owner}/${repo}`;
  const octokit = await getOctokit();

  // A repos.get through the installation token both proves the App can reach the
  // repo and yields the *real* default branch. We never fall back to a guessed
  // "main": a wrong guess would 404 the protection probe on a non-default branch
  // and mis-report a configured repo as unprotected (issue #70).
  let repoAccess: RepoAccess = "unreachable";
  let defaultBranch: string | null = null;
  try {
    const { data } = await octokit.rest.repos.get({ owner, repo });
    repoAccess = "accessible";
    defaultBranch = data.default_branch;
  } catch (err) {
    // A 404/403 both mean the installation can't see this repo — a specific,
    // actionable owner fix. Anything else is a transient/unknown fault: fail
    // closed as `unreachable` (not `inaccessible`) so we don't tell the owner to
    // touch an installation that isn't broken, and log it (issue #70).
    if (isNotFound(err) || isForbidden(err)) {
      repoAccess = "inaccessible";
    } else {
      console.error(`[preflight] repos.get failed for ${repoLabel}:`, err);
    }
  }

  // A null default branch means repos.get did not succeed, so repoAccess already
  // carries why (inaccessible or unreachable) and the dependent checks are skipped.
  if (defaultBranch === null) {
    return evaluatePreflight({
      repoConfigured: true,
      repo: repoLabel,
      repoAccess,
      branchProtection: "unprotected",
      reviewerIsCollaborator: false,
      signoffLabelExists: false,
      issuesWritable: false,
    });
  }

  const [branchProtection, reviewerIsCollaborator, signoffLabelExists, issuesWritable] =
    await Promise.all([
      probeBranchProtection(octokit, owner, repo, defaultBranch),
      isReviewerCollaborator(octokit, owner, repo),
      apiCheck(`getLabel ${repoLabel}`, () =>
        octokit.rest.issues.getLabel({ owner, repo, name: HUMAN_SIGNOFF_LABEL })
      ),
      hasIssuesWrite(),
    ]);

  return evaluatePreflight({
    repoConfigured: true,
    repo: repoLabel,
    repoAccess: "accessible",
    branchProtection,
    reviewerIsCollaborator,
    signoffLabelExists,
    issuesWritable,
  });
}

/** Compute a project's preflight and persist the status + reason. */
async function storePreflight(project: ProjectRow): Promise<PreflightResult> {
  const result = await computePreflight(project);
  db.update(projects)
    .set({ preflightStatus: result.status, preflightReason: result.reason })
    .where(eq(projects.id, project.id))
    .run();
  return result;
}

/**
 * Compute and store a single project's preflight. Returns the result, or null
 * if GitHub is not configured (nothing to check against) or the project is
 * gone. Callers use the return value to surface the outcome immediately (the
 * autonomy toggle) or ignore it (the periodic refresh, which only writes).
 */
export async function refreshProjectPreflight(projectId: string): Promise<PreflightResult | null> {
  if (!isGitHubConfigured()) return null;
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) return null;
  return storePreflight(project);
}

/**
 * Refresh preflight for every autonomy-enabled project. Dormant projects are
 * skipped — the reducer and the dashboard only care about preflight where
 * autonomy is on, so there is no point spending API calls elsewhere.
 */
export async function refreshAllPreflights(): Promise<void> {
  if (!isGitHubConfigured()) return;
  const rows = db.select().from(projects).where(eq(projects.autonomyEnabled, true)).all();
  for (const project of rows) {
    try {
      await storePreflight(project);
    } catch (err) {
      console.error(`[preflight] Refresh failed for ${project.githubRepo}:`, err);
    }
  }
}

let refreshInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic preflight refresh: one run now, then every few minutes.
 * Keeps stored status honest as repo settings drift (e.g. branch protection
 * removed) without waiting for the next toggle.
 */
export function startPreflightRefresh(): void {
  if (refreshInterval) return;
  if (!isGitHubConfigured()) return;
  console.log(
    `[preflight] Refreshing enabled projects every ${PREFLIGHT_REFRESH_INTERVAL_MS / 60_000}m`
  );
  void refreshAllPreflights().catch((err) =>
    console.error("[preflight] Initial refresh failed:", err)
  );
  refreshInterval = setInterval(
    () => void refreshAllPreflights().catch((err) => console.error("[preflight] Refresh failed:", err)),
    PREFLIGHT_REFRESH_INTERVAL_MS
  );
}

export function stopPreflightRefresh(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}
