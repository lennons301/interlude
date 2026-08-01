/**
 * The Phase 5 decision reducer (issue #15): given a snapshot of the world,
 * decide what the autonomy loop does next. Pure — time and all state arrive
 * in the snapshot, nothing inside reads a clock, a database, Docker, GitHub
 * or Discord. The webhook fast path and the reconciliation sweep both feed
 * this one function, so there is a single decision path, and the executor
 * (sweep.ts) is a thin performer of the Actions returned here.
 */

import { evaluateGates, type GateConfig } from "./gates";
import { selectWorkflow, type WorkflowSelection } from "./ticket";

export interface ProjectSnapshot {
  id: string;
  /** "owner/repo" */
  repo: string;
  autonomyEnabled: boolean;
  preflightStatus: "passing" | "failing" | null;
  preflightReason: string | null;
}

/** An open issue labelled `ready-for-agent`, as gathered by the sweep. */
export interface CandidateIssue {
  /** "owner/repo#n" */
  issueRef: string;
  /** "owner/repo" */
  repo: string;
  number: number;
  title: string;
  body: string;
  /** GitHub login of the issue author */
  author: string;
  labels: string[];
  /** When `ready-for-agent` was applied (falls back to issue creation time) */
  armedAt: Date;
  hasOpenBlocker: boolean;
  /** Attempts already consumed (failed runs) for this issue */
  attemptsMade: number;
  hasActiveRun: boolean;
}

/**
 * A finished implement pass whose PR awaits its gate decision. The configs
 * were read from default branches (never the PR's head) and parsed by the
 * gatherer; a parse or read failure arrives as `ok: false` so the reducer
 * can fail closed instead of guessing.
 */
export interface PendingGateEvaluation {
  runId: string;
  /** "owner/repo#n" */
  issueRef: string;
  prNumber: number;
  /** Paths the PR changes, from the GitHub API */
  changedPaths: string[];
  gateConfig:
    | { ok: true; estate: GateConfig; extension: GateConfig }
    | { ok: false; reason: string };
}

export interface AutonomySnapshot {
  now: Date;
  autonomyEnabledGlobal: boolean;
  attemptBudgetUsd: number;
  maxAttempts: number;
  /** Extra allow-listed authors beyond each repo's owner (lowercase) */
  allowedAuthors: string[];
  slots: { total: number; occupied: number; occupants: string[] };
  /** Queued interactive tasks waiting for a slot — they outrank new claims */
  queuedInteractiveCount: number;
  /** Implement tasks already claimed but not yet started — each has a slot
   * spoken for, so new claims must not double-book it */
  queuedImplementCount: number;
  /** Whether the current saturation transition was already announced */
  saturationAnnounced: boolean;
  projects: ProjectSnapshot[];
  candidates: CandidateIssue[];
  /** Issue refs whose claim is currently being executed (idempotency) */
  inFlightClaims: string[];
  /** Finished implement passes whose PRs await a gate decision */
  pendingGateEvaluations: PendingGateEvaluation[];
  /** Run IDs whose gate-config failure was already announced — the owner is
   * told once per failure, not once per sweep */
  announcedGateConfigErrors: string[];
}

export type PauseReason =
  | "autonomy-off-global"
  | "autonomy-off-project"
  | "preflight-failing"
  | "no-slots";

export type Action =
  | {
      type: "claimIssue";
      issueRef: string;
      projectId: string;
      issueNumber: number;
      issueTitle: string;
      issueBody: string;
      attempt: number;
      mode: "autonomous";
      budgetUsd: number;
      workflow: WorkflowSelection;
    }
  | { type: "pausePickup"; reason: PauseReason; detail?: string }
  | {
      type: "notify";
      event: "slots-saturated";
      payload: { occupied: number; total: number; occupants: string[] };
    }
  | {
      type: "gatePr";
      runId: string;
      issueRef: string;
      prNumber: number;
      categories: string[];
    }
  | { type: "armAutoMerge"; runId: string; issueRef: string; prNumber: number }
  | {
      type: "notify";
      event: "gate-config-error";
      payload: { runId: string; issueRef: string; prNumber: number; reason: string };
    };

/** Allowed by default: the repo owner; extended by the configured allow-list. */
function isAuthorAllowed(candidate: CandidateIssue, allowedAuthors: string[]): boolean {
  const author = candidate.author.toLowerCase();
  const repoOwner = candidate.repo.split("/")[0].toLowerCase();
  return author === repoOwner || allowedAuthors.some((a) => a.toLowerCase() === author);
}

export function decideNext(snapshot: AutonomySnapshot): Action[] {
  const actions: Action[] = [];

  // Announced once per transition into saturation — the executor clears the
  // flag when a slot frees, so "both slots busy" is a visible state, not spam.
  const saturated = snapshot.slots.occupied >= snapshot.slots.total;
  if (saturated && !snapshot.saturationAnnounced) {
    actions.push({
      type: "notify",
      event: "slots-saturated",
      payload: {
        occupied: snapshot.slots.occupied,
        total: snapshot.slots.total,
        occupants: snapshot.slots.occupants,
      },
    });
  }

  // Gate decisions come before new claims: finish in-flight work first.
  // Whether an agent-authored PR may merge without a human is decided here,
  // by data — changed paths against config from default branches. A config
  // that is missing or unparseable fails closed: nothing armed, the owner
  // told (once), and the run left pending so a config fix picks it up again.
  for (const pending of snapshot.pendingGateEvaluations) {
    if (!pending.gateConfig.ok) {
      if (!snapshot.announcedGateConfigErrors.includes(pending.runId)) {
        actions.push({
          type: "notify",
          event: "gate-config-error",
          payload: {
            runId: pending.runId,
            issueRef: pending.issueRef,
            prNumber: pending.prNumber,
            reason: pending.gateConfig.reason,
          },
        });
      }
      continue;
    }

    const categories = evaluateGates(
      pending.gateConfig.estate,
      pending.gateConfig.extension,
      pending.changedPaths
    );
    if (categories.length > 0) {
      actions.push({
        type: "gatePr",
        runId: pending.runId,
        issueRef: pending.issueRef,
        prNumber: pending.prNumber,
        categories,
      });
    } else {
      actions.push({
        type: "armAutoMerge",
        runId: pending.runId,
        issueRef: pending.issueRef,
        prNumber: pending.prNumber,
      });
    }
  }

  if (snapshot.candidates.length === 0) return actions;

  if (!snapshot.autonomyEnabledGlobal) {
    actions.push({ type: "pausePickup", reason: "autonomy-off-global" });
    return actions;
  }

  const pausedProjects = new Set<string>();
  const pauseProjectOnce = (project: ProjectSnapshot, reason: PauseReason, detail: string) => {
    if (pausedProjects.has(project.repo)) return;
    pausedProjects.add(project.repo);
    actions.push({ type: "pausePickup", reason, detail });
  };

  const eligible: Array<{ candidate: CandidateIssue; project: ProjectSnapshot }> = [];
  for (const candidate of snapshot.candidates) {
    const project = snapshot.projects.find((p) => p.repo === candidate.repo);
    if (!project) continue;
    if (!project.autonomyEnabled) {
      pauseProjectOnce(project, "autonomy-off-project", project.repo);
      continue;
    }
    // Fail closed: never-checked preflight is as ineligible as a failing one
    if (project.preflightStatus !== "passing") {
      pauseProjectOnce(
        project,
        "preflight-failing",
        `${project.repo}: ${project.preflightReason ?? "preflight has never run"}`
      );
      continue;
    }
    if (!isAuthorAllowed(candidate, snapshot.allowedAuthors)) continue;
    if (candidate.hasOpenBlocker) continue;
    if (candidate.hasActiveRun) continue;
    // Refuse a claim past the attempt budget even before #18's exhaust flow
    // lands — an unattended claim-fail loop must be bounded from day one.
    if (candidate.attemptsMade >= snapshot.maxAttempts) continue;
    if (snapshot.inFlightClaims.includes(candidate.issueRef)) continue;
    eligible.push({ candidate, project });
  }

  // Oldest-armed-first, globally. Priority is expressed by when work is
  // armed; there is deliberately no other ordering input.
  eligible.sort(
    (a, b) =>
      a.candidate.armedAt.getTime() - b.candidate.armedAt.getTime() ||
      a.candidate.issueRef.localeCompare(b.candidate.issueRef)
  );

  if (eligible.length === 0) return actions;

  // Priority order: in-flight work already holds its slot (it is counted in
  // `occupied`), a queued interactive task reserves the next free slot, an
  // already-claimed implement task reserves the slot it is waiting for, and
  // only what remains may go to new autonomous claims.
  const freeSlots = Math.max(0, snapshot.slots.total - snapshot.slots.occupied);
  const claimableSlots = Math.max(
    0,
    freeSlots - snapshot.queuedInteractiveCount - snapshot.queuedImplementCount
  );

  if (claimableSlots === 0) {
    actions.push({ type: "pausePickup", reason: "no-slots" });
    return actions;
  }

  for (const { candidate, project } of eligible.slice(0, claimableSlots)) {
    actions.push({
      type: "claimIssue",
      issueRef: candidate.issueRef,
      projectId: project.id,
      issueNumber: candidate.number,
      issueTitle: candidate.title,
      issueBody: candidate.body,
      attempt: candidate.attemptsMade + 1,
      mode: "autonomous",
      budgetUsd: snapshot.attemptBudgetUsd,
      workflow: selectWorkflow(candidate.body, candidate.labels),
    });
  }

  return actions;
}
