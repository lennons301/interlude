/**
 * The Phase 5 decision reducer (issue #15): given a snapshot of the world,
 * decide what the autonomy loop does next. Pure — time and all state arrive
 * in the snapshot, nothing inside reads a clock, a database, Docker, GitHub
 * or Discord. The webhook fast path and the reconciliation sweep both feed
 * this one function, so there is a single decision path, and the executors
 * — sweep.ts for pickup, gating and the review pipeline, the turn manager
 * for a finished pass's park-or-proceed — are thin performers of the Actions
 * returned here.
 */

import { detectBlockedQuestion } from "./blocked";
import { evaluateGates, type GateConfig } from "./gates";
import { selectWorkflow, type WorkflowSelection } from "./ticket";
import {
  buildFeedbackTurn,
  undeliverableFeedbackBody,
  type ReviewVerdictKind,
  type ReviewVerdictResult,
} from "./verdict";

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

/**
 * A run whose PR has had its gate decision (auto-merge armed, or gated with
 * `human-signoff`) and which now awaits its review pass. `hasReviewTask`
 * carries the "already queued or running" fact so re-deciding stays
 * idempotent across sweeps.
 */
export interface AwaitingReview {
  runId: string;
  /** "owner/repo#n" */
  issueRef: string;
  prNumber: number;
  /** Auto-merge armed (ungated) vs waiting on human sign-off (gated) */
  armed: boolean;
  hasReviewTask: boolean;
}

/**
 * A finished review pass whose stored verdict awaits its consequences. The
 * pass's output was parsed when its container finished; the reducer maps the
 * result to actions and the executor performs them with the reviewer
 * credential that no container ever holds.
 */
export interface PendingVerdict {
  runId: string;
  /** "owner/repo#n" */
  issueRef: string;
  prNumber: number;
  /** Auto-merge armed (ungated) vs gated */
  armed: boolean;
  result: ReviewVerdictResult;
  /** The implement task whose container can take a fix-up turn; null once
   * that container is gone (restart, failure, teardown) */
  implementTaskId: string | null;
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

/** A reviewed PR that has since closed on GitHub — merged by auto-merge or
 * a human, or closed without merging. The run's ledger row can settle. */
export interface SettledPr {
  runId: string;
  /** "owner/repo#n" */
  issueRef: string;
  prNumber: number;
  merged: boolean;
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
  /** Implement turns that just ended, awaiting park-or-proceed. The sweep
   * always passes []; the turn manager evaluates each outcome at the moment
   * the turn finishes. */
  completedPasses: PassOutcome[];
  /** Review tasks sitting in the queue — each has a slot spoken for */
  queuedReviewCount: number;
  /** Runs past their gate decision that await a review pass */
  awaitingReview: AwaitingReview[];
  /** Finished review passes whose verdicts await their consequences */
  pendingVerdicts: PendingVerdict[];
  /** Reviewed PRs that have closed on GitHub — their runs can settle */
  settledPrs: SettledPr[];
  /** Run IDs whose verdict failure was already announced (once per failure) */
  announcedVerdictErrors: string[];
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
    }
  | { type: "startReview"; runId: string; issueRef: string; prNumber: number; armed: boolean }
  | {
      type: "postVerdict";
      runId: string;
      issueRef: string;
      prNumber: number;
      verdict: ReviewVerdictKind;
      body: string;
      armed: boolean;
    }
  | { type: "deliverFeedback"; runId: string; taskId: string; issueRef: string; body: string }
  | {
      type: "notify";
      event: "verdict-unparseable";
      payload: {
        runId: string;
        issueRef: string;
        prNumber: number;
        reason: string;
        armed: boolean;
      };
    }
  | {
      type: "finalizeRun";
      runId: string;
      issueRef: string;
      prNumber: number;
      outcome: "merged" | "closed";
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
 * outside a sweep: every pickup, gating, review and saturation input is
 * inert, so the only possible decision is about the pass itself.
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
    pendingGateEvaluations: [],
    announcedGateConfigErrors: [],
    completedPasses: [pass],
    queuedReviewCount: 0,
    awaitingReview: [],
    pendingVerdicts: [],
    settledPrs: [],
    announcedVerdictErrors: [],
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

  // A finished pass that leads with the blocked marker is parked and its
  // question escalated; a healthy pass gets no action here — the turn
  // manager proceeds to completion. A run escalated as blocked is driven by
  // exactly one thing — its question: the executors never gather a blocked
  // run into the review pipeline (it leaves the reviewing/gated set), but
  // the combination is representable in a snapshot, so the reducer refuses
  // to double-drive it rather than trusting the callers.
  const blockedRunIds = new Set<string>();
  for (const pass of snapshot.completedPasses) {
    const question = detectBlockedQuestion(pass.finalMessage);
    if (question) {
      blockedRunIds.add(pass.runId);
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

  // Settled PRs first: pure ledger bookkeeping for work that already landed
  // (or was closed by a human) — nothing downstream depends on it this sweep.
  for (const settled of snapshot.settledPrs) {
    if (blockedRunIds.has(settled.runId)) continue;
    actions.push({
      type: "finalizeRun",
      runId: settled.runId,
      issueRef: settled.issueRef,
      prNumber: settled.prNumber,
      outcome: settled.merged ? "merged" : "closed",
    });
  }

  // Verdicts next — in-flight work outranks everything else, and a fix-up
  // turn resumes a parked container, so it takes a free slot ahead of any
  // reservation below. A request-changes with no slot free is held whole
  // (review post and fix-up together) for a later sweep: posting the review
  // without delivering the feedback would strand the run mid-cycle.
  let slotsLeft = Math.max(0, snapshot.slots.total - snapshot.slots.occupied);
  for (const pending of snapshot.pendingVerdicts) {
    if (blockedRunIds.has(pending.runId)) continue;
    const { result } = pending;

    if (result.kind === "unparseable") {
      // The fail-closed case: no review is posted, nothing is armed, the
      // owner is told (once). The executor disarms and adds human oversight.
      if (!snapshot.announcedVerdictErrors.includes(pending.runId)) {
        actions.push({
          type: "notify",
          event: "verdict-unparseable",
          payload: {
            runId: pending.runId,
            issueRef: pending.issueRef,
            prNumber: pending.prNumber,
            reason: result.reason,
            armed: pending.armed,
          },
        });
      }
      continue;
    }

    if (result.kind === "request-changes") {
      if (pending.implementTaskId === null) {
        // The container that could apply the feedback is gone; the findings
        // escalate to a human rather than burning a fresh attempt here.
        actions.push({
          type: "postVerdict",
          runId: pending.runId,
          issueRef: pending.issueRef,
          prNumber: pending.prNumber,
          verdict: "escalate",
          body: undeliverableFeedbackBody(result.body),
          armed: pending.armed,
        });
        continue;
      }
      if (slotsLeft === 0) continue;
      slotsLeft--;
      actions.push({
        type: "postVerdict",
        runId: pending.runId,
        issueRef: pending.issueRef,
        prNumber: pending.prNumber,
        verdict: "request-changes",
        body: result.body,
        armed: pending.armed,
      });
      actions.push({
        type: "deliverFeedback",
        runId: pending.runId,
        taskId: pending.implementTaskId,
        issueRef: pending.issueRef,
        body: buildFeedbackTurn(pending.prNumber, result.body),
      });
      continue;
    }

    actions.push({
      type: "postVerdict",
      runId: pending.runId,
      issueRef: pending.issueRef,
      prNumber: pending.prNumber,
      verdict: result.kind,
      body: result.body,
      armed: pending.armed,
    });
  }

  // Review passes are queued before gate decisions and claims: they finish
  // work already in flight. The queue starts them under the ordinary
  // capacity check, so emitting one here only reserves intent, not a slot.
  let reviewsQueuedThisSweep = 0;
  for (const awaiting of snapshot.awaitingReview) {
    if (blockedRunIds.has(awaiting.runId)) continue;
    if (awaiting.hasReviewTask) continue;
    reviewsQueuedThisSweep++;
    actions.push({
      type: "startReview",
      runId: awaiting.runId,
      issueRef: awaiting.issueRef,
      prNumber: awaiting.prNumber,
      armed: awaiting.armed,
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
  // `occupied`, and a fix-up turn delivered above decremented `slotsLeft`),
  // a queued interactive task reserves the next free slot, an
  // already-claimed implement task or a queued review pass reserves the slot
  // it is waiting for, and only what remains may go to new autonomous claims.
  const claimableSlots = Math.max(
    0,
    slotsLeft -
      snapshot.queuedInteractiveCount -
      snapshot.queuedImplementCount -
      snapshot.queuedReviewCount -
      reviewsQueuedThisSweep
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
