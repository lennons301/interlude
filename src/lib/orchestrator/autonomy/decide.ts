/**
 * The Phase 5 decision reducer (issue #15): given a snapshot of the world,
 * decide what the autonomy loop does next. Pure — time and all state arrive
 * in the snapshot, nothing inside reads a clock, a database, Docker, GitHub
 * or Discord. The webhook fast path and the reconciliation sweep both feed
 * this one function, so there is a single decision path, and the executor
 * (sweep.ts) is a thin performer of the Actions returned here.
 */

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
  /** Whether the current saturation transition was already announced */
  saturationAnnounced: boolean;
  projects: ProjectSnapshot[];
  candidates: CandidateIssue[];
  /** Issue refs whose claim is currently being executed (idempotency) */
  inFlightClaims: string[];
}

export type Action = {
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
};

export function decideNext(snapshot: AutonomySnapshot): Action[] {
  const actions: Action[] = [];

  for (const candidate of snapshot.candidates) {
    const project = snapshot.projects.find((p) => p.repo === candidate.repo);
    if (!project) continue;

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
      workflow: selectWorkflow(),
    });
  }

  return actions;
}
