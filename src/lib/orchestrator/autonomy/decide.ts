/**
 * The Phase 5 decision reducer (issue #15): given a snapshot of the world,
 * decide what the autonomy loop does next. Pure — time and all state arrive
 * in the snapshot, nothing inside reads a clock, a database, Docker, GitHub
 * or Discord. The webhook fast path and the reconciliation sweep both feed
 * this one function, so there is a single decision path, and the executor
 * (sweep.ts) is a thin performer of the Actions returned here.
 */

import { detectBlockedQuestion } from "./blocked";
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

/** An implement turn that just finished, up for a park-or-proceed decision. */
export interface PassOutcome {
  runId: string;
  taskId: string;
  /** "owner/repo#n" */
  issueRef: string;
  /** The turn's final agent text message; null when the turn produced none */
  finalMessage: string | null;
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
  /** Implement turns that just ended, awaiting park-or-proceed. The sweep
   * always passes []; the turn manager evaluates each outcome at the moment
   * the turn finishes. */
  completedPasses: PassOutcome[];
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
      type: "escalate";
      reason: "blocked";
      runId: string;
      taskId: string;
      issueRef: string;
      question: string;
    };

/**
 * A snapshot for deciding one finished pass at the moment its turn ends,
 * outside a sweep: every pickup and saturation input is inert, so the only
 * possible decision is about the pass itself.
 */
export function passOutcomeSnapshot(now: Date, pass: PassOutcome): AutonomySnapshot {
  return {
    now,
    autonomyEnabledGlobal: true,
    attemptBudgetUsd: 0,
    maxAttempts: 0,
    allowedAuthors: [],
    slots: { total: 0, occupied: 0, occupants: [] },
    queuedInteractiveCount: 0,
    queuedImplementCount: 0,
    saturationAnnounced: true,
    projects: [],
    candidates: [],
    inFlightClaims: [],
    completedPasses: [pass],
  };
}

/** Allowed by default: the repo owner; extended by the configured allow-list. */
function isAuthorAllowed(candidate: CandidateIssue, allowedAuthors: string[]): boolean {
  const author = candidate.author.toLowerCase();
  const repoOwner = candidate.repo.split("/")[0].toLowerCase();
  return author === repoOwner || allowedAuthors.some((a) => a.toLowerCase() === author);
}

export function decideNext(snapshot: AutonomySnapshot): Action[] {
  const actions: Action[] = [];

  // A finished pass that leads with the blocked marker is parked and its
  // question escalated; a healthy pass gets no action here — the turn
  // manager proceeds to completion.
  for (const pass of snapshot.completedPasses) {
    const question = detectBlockedQuestion(pass.finalMessage);
    if (question) {
      actions.push({
        type: "escalate",
        reason: "blocked",
        runId: pass.runId,
        taskId: pass.taskId,
        issueRef: pass.issueRef,
        question,
      });
    }
  }

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
