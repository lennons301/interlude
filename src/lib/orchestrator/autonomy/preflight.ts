/**
 * Autonomy preflight (issue #26) — the deterministic answer to "is this repo
 * safe to run unattended against?". A project must pass every check before the
 * reducer will claim any of its tickets (decide.ts fails closed on a
 * never-checked or failing preflight), so this is the gate that turns the loop
 * on for a repo.
 *
 * The mapping from check results to a stored status + human-readable reason is
 * a pure function (`evaluatePreflight`) so it is table-testable with no I/O;
 * `computePreflight` is the thin GitHub-API shell that gathers the booleans.
 * The reason names what is missing, which is what the dashboard's "needs you"
 * bucket and the pause log surface to the owner.
 */

import { db } from "@/db";
import { projects } from "@/db/schema";
import { eq } from "drizzle-orm";
import { Octokit } from "octokit";
import { getConfig } from "../../config";
import { getOctokit, isGitHubConfigured } from "../../github/client";
import { HUMAN_SIGNOFF_LABEL } from "./gates";

/** Every requirement autonomy depends on, as plain booleans. */
export interface PreflightChecks {
  /** Project has both a gitUrl and an owner/repo githubRepo */
  repoConfigured: boolean;
  /** The GitHub App installation can see the repo (clone/push + API) */
  appInstalled: boolean;
  /** The default branch has branch protection */
  branchProtected: boolean;
  /** The reviewer machine account is a collaborator on the repo */
  reviewerIsCollaborator: boolean;
  /** The `human-signoff` label exists so gated PRs can be labelled */
  signoffLabelExists: boolean;
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
 * missing. `repoConfigured` and `appInstalled` are prerequisites — without them
 * the remaining checks cannot even be gathered, so a failure there short-circuits
 * to a single clear reason rather than a misleading list. The other three are
 * independent and accumulate, so the owner fixes everything in one pass.
 */
export function evaluatePreflight(checks: PreflightChecks): PreflightResult {
  if (!checks.repoConfigured) {
    return { status: "failing", reason: "no GitHub repo configured (needs gitUrl and githubRepo)" };
  }
  if (!checks.appInstalled) {
    return { status: "failing", reason: "the GitHub App is not installed on the repository" };
  }

  const missing: string[] = [];
  if (!checks.branchProtected) missing.push("no branch protection on the default branch");
  if (!checks.reviewerIsCollaborator) missing.push("the reviewer account is not a collaborator");
  if (!checks.signoffLabelExists) missing.push(`the "${HUMAN_SIGNOFF_LABEL}" label is missing`);

  return missing.length === 0
    ? { status: "passing", reason: null }
    : { status: "failing", reason: missing.join("; ") };
}

type ProjectRow = typeof projects.$inferSelect;

/** Did an Octokit call fail with an HTTP 404 (as opposed to a real error)? */
function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { status?: number }).status === 404;
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

/**
 * Gather the four autonomy checks for a project via the GitHub API. Every
 * network failure resolves a check to `false` (fail closed) so an unreachable
 * or under-permissioned repo never reads as ready. Downstream checks are only
 * attempted once the App is confirmed installed, since they all need the
 * installation token.
 */
export async function computePreflight(project: ProjectRow): Promise<PreflightResult> {
  const repoConfigured = !!project.gitUrl && !!project.githubRepo;
  const [owner, repo] = (project.githubRepo ?? "").split("/");
  if (!repoConfigured || !owner || !repo) {
    return evaluatePreflight({
      repoConfigured: false,
      appInstalled: false,
      branchProtected: false,
      reviewerIsCollaborator: false,
      signoffLabelExists: false,
    });
  }

  const octokit = await getOctokit();

  // App installed — a repos.get through the installation token both proves the
  // App can see the repo and yields the default branch for the next check.
  let appInstalled = false;
  let defaultBranch = "main";
  try {
    const { data } = await octokit.rest.repos.get({ owner, repo });
    appInstalled = true;
    defaultBranch = data.default_branch;
  } catch (err) {
    if (!isNotFound(err)) {
      console.error(`[preflight] repos.get failed for ${owner}/${repo}:`, err);
    }
  }

  if (!appInstalled) {
    return evaluatePreflight({
      repoConfigured: true,
      appInstalled: false,
      branchProtected: false,
      reviewerIsCollaborator: false,
      signoffLabelExists: false,
    });
  }

  const [branchProtected, reviewerIsCollaborator, signoffLabelExists] = await Promise.all([
    octokit.rest.repos
      .getBranchProtection({ owner, repo, branch: defaultBranch })
      .then(() => true)
      .catch((err) => {
        if (!isNotFound(err)) {
          console.error(`[preflight] getBranchProtection failed for ${owner}/${repo}:`, err);
        }
        return false;
      }),
    reviewerLogin().then((login) =>
      login
        ? octokit.rest.repos
            .checkCollaborator({ owner, repo, username: login })
            .then(() => true)
            .catch(() => false)
        : false
    ),
    octokit.rest.issues
      .getLabel({ owner, repo, name: HUMAN_SIGNOFF_LABEL })
      .then(() => true)
      .catch(() => false),
  ]);

  return evaluatePreflight({
    repoConfigured: true,
    appInstalled: true,
    branchProtected,
    reviewerIsCollaborator,
    signoffLabelExists,
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
