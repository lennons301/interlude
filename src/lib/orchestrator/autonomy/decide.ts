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

import type { FailedCheck } from "../../github/pull-requests";
import type { LaneBilling } from "../../lanes/lane-config";
import type { LaneFailoverOption } from "../../lanes/lane-selection";
import { evaluateMeteredSpend } from "../../lanes/money";
import { evaluateQuotaGate } from "../../quota/quota-gate";
import type { QuotaObservation } from "../../quota/rate-limit-event";
import { detectBlockedQuestion } from "./blocked";
import { resumeEligibleAt } from "./resume-jitter";
import { evaluateGates, type GateConfig } from "./gates";
import {
  NEEDS_INFO_LABEL,
  READY_FOR_HUMAN_LABEL,
  parseTicketDirectives,
  selectWorkflow,
  type WorkflowSelection,
} from "./ticket";
import type { ModelTier } from "../../model-tiers";
import type { QuotaRejection } from "../../quota/rate-limit-rejection";
import { planTierDegrade } from "../../quota/tier-ladder";
import { chooseRunTier, type RunTierChoice, type TriageExitKind, type TriageResult } from "./triage";
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
  /** Runs lost to orchestrator restarts (interrupted runs) for this issue —
   * counted separately from attempts: the platform's downtime is never
   * charged to the ticket, but the re-claim is bounded */
  interruptionsMade: number;
  hasActiveRun: boolean;
  /** The tier the issue's most recent triage pass suggested for its work
   * (issue #200), read off `tasks.triageTier`; null when no pass suggested
   * one. Advice the claim applies only where the body states no `model:`
   * directive — a tier in the Workflow section always outranks it. */
  triageTier: ModelTier | null;
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
  /** The run's checkpoint text, stored at claim time; non-null means the run
   * is supervised and must gate regardless of what the globs match */
  checkpoint: string | null;
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
  /** The PR's head as the sweep read it — recorded on the run when the verdict
   * is posted (runs.reviewedHeadSha, issue #131), so a later push can be seen
   * as movement past the commit that was actually reviewed */
  headSha: string;
  /** The implement task whose container can take a fix-up turn; null once
   * that container is gone (restart, failure, teardown) */
  implementTaskId: string | null;
  /** Fix-up turns already bought by request-changes verdicts this attempt */
  reviewCycleCount: number;
  /** Unparseable verdicts this attempt has already produced
   * (runs.reviewUnparseableCount). Below `maxUnparseableRetries` an
   * unparseable verdict buys one more review pass with the parse failure fed
   * back; at or past it the verdict fails closed (issue #89). Named to mirror
   * the sibling `reviewCycleCount`. */
  reviewUnparseableCount: number;
}

/** An implement turn that just finished, up for a park-or-proceed decision. */
export interface PassOutcome {
  runId: string;
  taskId: string;
  /** "owner/repo#n" */
  issueRef: string;
  /** The turn's final agent text message; null when the turn produced none */
  finalMessage: string | null;
  /** Whether the pass left a PR behind — the run has something to review and
   * merge. A pass that ends with neither a PR nor a `BLOCKED:` question has
   * nothing to advance its run, so the reducer finalizes it here rather than
   * letting the run dangle non-terminal as a ghost `running` card (issue
   * #106). Only ever false for a genuine implement pass — a repair always
   * operates on an existing PR, so its callers report `true`. */
  producedPr: boolean;
  /**
   * The quota wall this turn hit, or null when it hit none (issue #168) — read
   * off the turn's own result by `detectQuotaRejection`, never re-derived here.
   *
   * Non-null outranks every other reading of the pass: a refused turn ran no
   * agent, so its final message is the CLI's own "you've hit your session
   * limit" and its empty diff is the wall's, not the work's. Judging either
   * would charge the account's quota to the ticket's attempt budget.
   *
   * It does not say *which* consequence follows — a tier-scoped window steps
   * the run down the ladder and an account-wide one parks it (issue #170) —
   * because that is the reducer's decision to make, from this and `tier`.
   */
  rateLimited: QuotaRejection | null;
  /**
   * The tier this pass actually ran at (issue #170), read off the run's
   * `model` column — the only place that records it — and normalised, so a
   * legacy alias resolves and a pinned raw model id (which names no tier)
   * arrives as null.
   *
   * The ladder's starting rung. Null means there is none: the deployment pins
   * a model id, or names no model at all and lets the harness choose, and in
   * neither case may the fleet invent a rung to step off. Such a pass takes
   * the pause exactly as it did before this ticket.
   */
  tier: ModelTier | null;
  /**
   * The execution lane this pass actually ran on (issue #176), read off the
   * task row — the ledger entry #174 writes at pass start. Null on a pass that
   * recorded none (a row written before lanes existed).
   *
   * The lane a failover must not send it back to, and the only honest source
   * for it: the *primary* lane may since have changed, and cost routing may
   * have sent this pass somewhere else in the first place.
   */
  laneId: string | null;
  /**
   * Where this pass could move to instead of pausing (issue #176) — the
   * cheapest lane other than the one that refused it that is available,
   * permitted and at or above this pass kind's floor, as `selectLane` ranks
   * them. Null when there is none, which is when a pause is still the answer.
   *
   * Handed in already ranked rather than decided here for the reason `tier`
   * is: the ranking needs the lane file, the environment, every lane's quota
   * row and the day's cash, and the reducer's job is the *ordering* — the tier
   * ladder first, a lane move next, the clock last — plus the bound below.
   */
  laneFailover: LaneFailoverOption | null;
  /**
   * Continuations this attempt has already had (`runs.resumeCount`), which is
   * what bounds a lane move: a move is a continuation of the same attempt
   * exactly as a resume is, so it counts against the same number rather than
   * getting a second one nobody would keep true. Past the bound the run pauses
   * (and #169's own bound then hands the ticket to a human), which is what
   * stops a run thrashing across lanes forever.
   */
  resumesMade: number;
}

/**
 * A run parked on the account's quota clock (issue #168), up for the decision
 * this ticket adds: resume it, or hand its ticket to a human because the
 * attempt has paused more often than the bound allows.
 *
 * Gathered every sweep, because the sweep is the resume driver — no new
 * scheduler, exactly as the 30-second reconciliation loop already drives every
 * other waiting thing.
 */
export interface PausedRun {
  runId: string;
  /** "owner/repo#n" */
  issueRef: string;
  /**
   * When the refusing window resets — the run's `resumeAfter`.
   *
   * Null means the row carries no clock, which #168 never writes (a rejection
   * with no reset time takes the ordinary failure path precisely so a run is
   * never parked on a window nobody knows the length of). If one appears
   * anyway it is treated as eligible now rather than left waiting forever:
   * stranding a run where no later ticket can find it is the failure this
   * whole ticket exists to prevent, and a wall that is still up simply pauses
   * it again — which the bound below counts.
   */
  resumeAfter: Date | null;
  /** Resumes this attempt has already had (runs.resumeCount) */
  resumesMade: number;
  /** A task of this run already queued or running — the idempotency fact, so
   * re-deciding across sweeps cannot queue a second resumed pass */
  hasLiveTask: boolean;
}

/** An open issue awaiting triage (`needs-triage`), as gathered by the sweep. */
export interface TriageCandidate {
  /** "owner/repo#n" */
  issueRef: string;
  /** "owner/repo" */
  repo: string;
  number: number;
  title: string;
  body: string;
  /** GitHub login of the issue author */
  author: string;
  /** A triage task already queued or running for this issue (idempotency) */
  hasTriageTask: boolean;
}

/**
 * A finished triage pass whose stored exit awaits application. The pass's
 * output was parsed when its container finished and stored on the task; the
 * reducer maps the exit to actions and the executor performs them — the pass
 * itself never labels, comments, edits or closes anything.
 */
export interface PendingTriage {
  taskId: string;
  /** "owner/repo#n" */
  issueRef: string;
  issueTitle: string;
  /** The issue body as it stands, so the recommendation can state the tier
   * the run will use (issue #200) under the same precedence the claim
   * applies: a `model:` directive in the body outranks the pass's suggestion */
  issueBody: string;
  projectId: string;
  result: TriageResult;
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

/**
 * A parked run (reviewing/gated) whose open PR the tracker reports as
 * CONFLICTING (issue #54): a human merge elsewhere moved the default branch
 * under it. Left alone this is an invisible stall, so the reducer drives an
 * integration repair or, once repairs are spent, escalates to a human. A PR
 * whose mergeability is still `unknown` never lands here — it is re-polled,
 * never treated as a verdict.
 */
export interface ConflictingPr {
  runId: string;
  /** "owner/repo#n" */
  issueRef: string;
  prNumber: number;
  /** Auto-merge armed (reviewing) vs gated — the executor disarms on escalate */
  armed: boolean;
  /** Repair passes already run this conflict episode (runs.integrationCount) */
  integrationsMade: number;
  /** A repair task already queued or running for this run (idempotency) */
  hasRepairTask: boolean;
}

/**
 * A parked run whose PR the tracker now reports as mergeable again after a
 * prior conflict (integrationCount > 0). The episode is over: its repair
 * counter resets so a future, unrelated conflict earns its own repairs
 * instead of escalating on a stale count.
 */
export interface ResolvedConflict {
  runId: string;
  /** "owner/repo#n" */
  issueRef: string;
}

/**
 * A parked run (reviewing/gated) whose open, textually-mergeable PR has a red
 * check rollup (issue #130) — the same invisible-stall shape as ConflictingPr,
 * for the case where the merge is clean but the branch does not build. Left
 * alone an armed run's auto-merge silently never fires and a gated one waits on
 * a human nobody told, so the reducer drives a bounded CI repair or, once those
 * are spent, escalates. A rollup that is pending or unreadable never reaches
 * this list, and a red one only does so once confirmed over consecutive sweeps.
 */
export interface ChecksFailingPr {
  runId: string;
  /** "owner/repo#n" */
  issueRef: string;
  prNumber: number;
  /** The head the rollup was read at — carried so the repair prompt and any
   * later stale-review handling (#131) name the commit that actually failed */
  headSha: string;
  /** Auto-merge armed (reviewing) vs gated — the executor disarms on escalate.
   * Either way the repair runs: a gated PR with red checks is equally stuck. */
  armed: boolean;
  /** The failed checks, for the repair prompt and the needs-you card */
  failedChecks: FailedCheck[];
  /** Consecutive sweeps this head's rollup has been observed failing — a
   * single-sweep failure is a suspected flake and spends nothing */
  sweepsFailing: number;
  /** CI-repair passes already run this episode (runs.ciRepairCount) */
  ciRepairsMade: number;
  /** A repair task already queued or running for this run (idempotency) */
  hasRepairTask: boolean;
}

/**
 * A parked run whose rollup is green again after a CI-repair episode
 * (ciRepairCount > 0): the episode is over, so its counter resets and a later
 * unrelated failure earns its own repair rather than escalating on a spent one.
 */
export interface ResolvedCheckFailure {
  runId: string;
  /** "owner/repo#n" */
  issueRef: string;
}

/**
 * A parked run whose PR head has moved past the commit its posted verdict was
 * written about (issue #131): a human clicked *Update branch*, pushed a commit,
 * or merged the default branch in. The approval standing on the PR is now
 * evidence about code nobody reviewed — and, left alone, an armed run would
 * auto-merge that head — so the run is disarmed, drops its verdict and gate
 * categories, re-gates against the new diff and takes one fresh review pass.
 * A head that has not moved never reaches this list (see review-head.ts).
 */
export interface StaleReview {
  runId: string;
  /** "owner/repo#n" */
  issueRef: string;
  prNumber: number;
  /** Auto-merge armed (reviewing) vs gated — the executor disarms either way
   * before anything else, then re-derives the gate decision from the new diff */
  armed: boolean;
  /** The head the posted verdict was written about (runs.reviewedHeadSha) */
  reviewedHeadSha: string;
  /** The head the PR carries now — named on the issue beside the old one */
  headSha: string;
  /** Implement↔review cycles already spent this attempt: a re-review costs one
   * like any other, and a run with none left goes to a human */
  reviewCycleCount: number;
  /** The sweep tried to withdraw the standing review and GitHub refused.
   * Dismissing a review on a protected branch needs administrator rights or a
   * place on the branch's dismissal allow-list, which the reviewer machine
   * account may not have — and an approval GitHub still counts must never be
   * re-armed over, so this routes to a human instead of another attempt. */
  dismissalFailed: boolean;
}

export interface AutonomySnapshot {
  now: Date;
  autonomyEnabledGlobal: boolean;
  /** The operator's global kill switch (issue #118), read fresh from the
   * settings row each sweep tick: engaged, no new autonomous pickup is decided
   * — no claim, no triage pass — while everything already in flight is decided
   * exactly as it would be otherwise. Distinct from `autonomyEnabledGlobal`,
   * which is the env boot master: false there and sweeps never start at all,
   * so nothing reaches this reducer to pause. */
  globalPaused: boolean;
  attemptBudgetUsd: number;
  maxAttempts: number;
  /** Interruptions (orchestrator restarts) tolerated per ticket before it is
   * routed back to a human instead of re-claimed */
  maxInterruptions: number;
  /** Implement↔review cycles allowed within one attempt */
  maxReviewCycles: number;
  /** Unparseable review verdicts re-queued per attempt before one fails
   * closed (issue #89) */
  maxUnparseableRetries: number;
  /** Repair passes allowed per conflict episode before a still-CONFLICTING
   * parked PR escalates to a human */
  maxIntegrationAttempts: number;
  /** Autonomous spend since local midnight — a sum over the runs ledger, so
   * interactive tasks (which have no run) are exempt by construction */
  todayAutonomousSpendUsd: number;
  /** Estate-wide daily autonomous spend cap in USD */
  dailyCapUsd: number;
  /** Whether today's cap pause was already announced */
  dailyCapAnnounced: boolean;
  // The money guards (issue #174) — the six fields below. All of them key off
  // the **billing kind** of the lane a pass would actually run on, not off
  // whether anything overflowed: a metered lane is a metered lane whether it is
  // primary, an overflow target or reached by failover, and metered-primary is
  // the configuration that would otherwise slip every guard.
  /** The lane in force, for the announcements that name it; null = none
   * resolves (an unreadable lane file, or a primary naming no declared lane). */
  primaryLaneId: string | null;
  /** Who pays for that lane. `null` = it could not be resolved, which decides
   * nothing either way: such a fleet spends nothing, because every pass fails
   * as it starts with the reason named, and a money hold invented on top would
   * only hide that. */
  primaryLaneBilling: LaneBilling | null;
  /** Real money spent through metered lanes since local midnight — every task,
   * not only run-owned ones, because the cap measures money rather than
   * autonomy (see `todayMeteredSpendUsd`). */
  meteredSpendTodayUsd: number;
  /** The real-money cap in force: the operator's dial, bound down by the
   * lane's own declared cap. */
  meteredCapUsd: number;
  /** When the fleet last confirmed it may spend real money; null = never. The
   * reducer judges it against `now`, so nothing has to clear it at midnight. */
  meteredSpendConfirmedAt: Date | null;
  /** Whether today's real-money cap pause was already announced */
  meteredCapAnnounced: boolean;
  /** Whether today's request for a spend confirmation was already announced */
  meteredConfirmationAnnounced: boolean;
  /**
   * The fleet's last quota observation (issue #171), from the durable row the
   * stream parser writes (#167). Null when nothing has ever been observed —
   * a fresh install, or one on API-key auth, where the CLI emits no quota
   * telemetry at all; that silence must never read as a wall.
   */
  quota: QuotaObservation | null;
  /** The utilization at or above which new pickup stops, already resolved
   * through the settings override / environment / built-in default chain, so
   * the reducer stays pure and a UI change takes effect at the next tick. */
  quotaThresholdPercent: number;
  /** Whether the current closed-gate transition was already announced */
  quotaGateAnnounced: boolean;
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
  /** Parked runs whose open PR is CONFLICTING — repaired or escalated */
  conflictingPrs: ConflictingPr[];
  /** Parked runs whose PR is mergeable again after a conflict — counter reset */
  resolvedConflicts: ResolvedConflict[];
  /** Parked runs whose mergeable PR has a red check rollup (issue #130) —
   * CI-repaired or escalated */
  checksFailingPrs: ChecksFailingPr[];
  /** Parked runs whose rollup is green again after a CI repair — counter reset */
  resolvedCheckFailures: ResolvedCheckFailure[];
  /** Parked runs whose PR head moved past the reviewed commit (issue #131) —
   * re-reviewed or escalated */
  staleReviews: StaleReview[];
  /** CI-repair passes allowed per failure episode before a still-red parked PR
   * escalates to a human */
  maxCiRepairAttempts: number;
  /** Consecutive sweeps a rollup must be seen failing before a repair is spent
   * — the flake guard, so an infrastructure blip does not burn the one repair */
  minCheckFailureSweeps: number;
  /** Run IDs whose failing-checks escalation was already announced (once) */
  announcedCheckEscalations: string[];
  /** Repair tasks sitting in the queue — each has a slot spoken for */
  queuedRepairCount: number;
  /** Run IDs whose conflict escalation was already announced (once per stall) */
  announcedIntegrationEscalations: string[];
  /** Open issues labelled `needs-triage` with no triage pass yet */
  triageCandidates: TriageCandidate[];
  /** Finished triage passes whose stored exits await application */
  pendingTriageResults: PendingTriage[];
  /** Triage tasks sitting in the queue — each has a slot spoken for */
  queuedTriageCount: number;
  /** Task IDs whose unparseable triage exit was already announced */
  announcedTriageErrors: string[];
  /** Runs parked on the quota clock (issue #169) — resumed once their window
   * has reset, or handed to a human once the resume bound is spent */
  pausedRuns: PausedRun[];
  /** Resumes one attempt may have after a quota pause before its ticket is
   * routed to a human. UI-settable (issue #166's layer), so it is a snapshot
   * field rather than a constant read inside the reducer. */
  maxResumesPerAttempt: number;
  /** The window a paused run's own offset is spread across, so a fleet-wide
   * pause does not put every run on the same tick — see resume-jitter.ts */
  resumeJitterMs: number;
}

export type PauseReason =
  | "autonomy-off-global"
  /** The durable global kill switch is engaged (issue #118) — a deliberate
   * runtime hold on pickup, lifted by a human, not by a new day or a free slot */
  | "kill-switch"
  | "autonomy-off-project"
  | "preflight-failing"
  | "no-slots"
  /** The estate's daily autonomous cap, or — since issue #174 — the real-money
   * cap on a metered lane. Deliberately one reason for both: they are two caps
   * feeding one mechanism, and the `detail` says which. */
  | "daily-cap"
  /** A metered lane has not been confirmed for this local day (issue #174).
   * Its own reason rather than the cap's, because the remedy is opposite: the
   * cap lifts itself at midnight and this one waits for a human press. */
  | "metered-unconfirmed"
  /** Quota is spent or nearly spent (issue #171) — the fleet stops starting
   * work it could not finish. Lifted by the window resetting, not by a human */
  | "quota-gate";

export type Action =
  | {
      type: "claimIssue";
      issueRef: string;
      projectId: string;
      issueNumber: number;
      issueTitle: string;
      issueBody: string;
      attempt: number;
      /** A checkpoint: directive makes the run supervised — forced
       * human-signoff at the gate decision, never auto-merge */
      mode: "autonomous" | "supervised";
      budgetUsd: number;
      /** The checkpoint's text — the decision waiting for the owner; null
       * for an ordinary autonomous run */
      checkpoint: string | null;
      /** Per-exec turn limit from a max-turns directive; null = the default */
      maxTurns: number | null;
      /** Model tier from a `model:` directive (issues #80, #166), normalised
       * to the tier vocabulary — or, where the body states none, the tier the
       * issue's triage pass suggested (issue #200); null = the configured
       * default tier. Recorded on runs.model. */
      model: string | null;
      /** Where `model` came from: the ticket's own directive, or triage's
       * stored suggestion filling the gap; null when neither stated one. The
       * claim comment names it so a tier that reached the run without
       * appearing in the body is still visible on the issue. */
      modelSource: "ticket" | "triage" | null;
      /** Reasoning-effort level from an `effort:` directive (issue #81),
       * clamped to the allowlist; null = the configured default. Recorded on
       * runs.effort. */
      effort: string | null;
      workflow: WorkflowSelection;
    }
  | { type: "pausePickup"; reason: PauseReason; detail?: string }
  | {
      type: "notify";
      event: "slots-saturated";
      payload: { occupied: number; total: number; occupants: string[] };
    }
  | {
      type: "notify";
      event: "daily-cap-reached";
      payload: { spentUsd: number; capUsd: number };
    }
  | {
      // The real-money cap (issue #174). Its own event rather than a field on
      // the one above, because the two say different things to a reader: that
      // one is "the fleet has worked hard today", this one is "the card has
      // been charged $X and stops here", and it names the lane doing the
      // charging.
      type: "notify";
      event: "metered-cap-reached";
      payload: { spentUsd: number; capUsd: number; laneId: string | null };
    }
  | {
      // Nobody is at the keyboard when an autonomous pass crosses into
      // billing, so the fleet asks: one ping per local day, the same
      // once-per-transition discipline every other announcement here keeps.
      // Without it a metered fleet would simply sit quiet, which is the
      // silent-wedge failure this codebase has been bitten by twice.
      type: "notify";
      event: "metered-confirmation-required";
      payload: { capUsd: number; laneId: string | null };
    }
  | {
      type: "notify";
      event: "quota-gate-closed";
      payload: {
        /** The status verbatim, as the CLI said it */
        status: string;
        /** The window closest to tripping, verbatim; null when unreported */
        rateLimitType: string | null;
        /** Percent of that window consumed; null when the event carried none */
        utilization: number | null;
        thresholdPercent: number;
        /** Whether the account is already rejecting, or the fleet stopped
         * short of that on purpose — different news, same hold */
        reason: "rejected" | "utilization";
        resetsAt: Date | null;
        /** How many armed tickets the gate is holding. The whole fleet being
         * stalled is what earns a Discord ping, so the count is the claim. */
        heldTickets: number;
      };
    }
  | {
      type: "gatePr";
      runId: string;
      issueRef: string;
      prNumber: number;
      categories: string[];
      /** The supervised run's checkpoint text, carried so the notification
       * names the decision that is waiting; null for a glob-matched gate */
      checkpoint: string | null;
    }
  | { type: "armAutoMerge"; runId: string; issueRef: string; prNumber: number }
  | {
      type: "notify";
      event: "gate-config-error";
      payload: { runId: string; issueRef: string; prNumber: number; reason: string };
    }
  | { type: "startReview"; runId: string; issueRef: string; prNumber: number; armed: boolean }
  | {
      // Re-queue a review pass whose prior verdict was unparseable (issue #89),
      // feeding the parse failure back so it can restate the verdict in shape.
      // The executor clears the stored result and counts the retry; a second
      // unparseable verdict falls to the fail-closed `verdict-unparseable` path.
      type: "retryReview";
      runId: string;
      issueRef: string;
      prNumber: number;
      armed: boolean;
      /** Why the prior verdict could not be parsed — injected into the retry
       * prompt verbatim (parser-generated, never container-controlled text) */
      parseFailure: string;
    }
  | {
      type: "postVerdict";
      runId: string;
      issueRef: string;
      prNumber: number;
      verdict: ReviewVerdictKind;
      body: string;
      armed: boolean;
      /** The head this verdict is about — stored with it, so the next sweep can
       * tell a reviewed head from one a push has moved (issue #131) */
      headSha: string;
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
      type: "repairPr";
      runId: string;
      issueRef: string;
      prNumber: number;
      /** Which repair this is (integrationsMade + 1) — for the issue comment */
      integration: number;
    }
  | {
      type: "escalateConflict";
      runId: string;
      issueRef: string;
      prNumber: number;
      /** Auto-merge armed — disarm before handing to a human */
      armed: boolean;
      /** Repairs spent before giving up — named in the escalation */
      integrationsMade: number;
    }
  | { type: "clearIntegration"; runId: string; issueRef: string }
  | {
      // A parked PR whose checks are red (issue #130): a bounded CI-repair pass
      // in a fresh container reads the failing checks, fixes them and pushes.
      type: "repairChecks";
      runId: string;
      issueRef: string;
      prNumber: number;
      /** The head whose rollup failed — named in the prompt so the pass fixes
       * the failure that was actually observed */
      headSha: string;
      failedChecks: FailedCheck[];
      /** Which CI repair this is (ciRepairsMade + 1) — for the issue comment */
      ciRepair: number;
    }
  | {
      type: "escalateChecks";
      runId: string;
      issueRef: string;
      prNumber: number;
      /** Auto-merge armed — disarm before handing to a human */
      armed: boolean;
      /** CI repairs spent before giving up — named in the escalation */
      ciRepairsMade: number;
      /** The checks still failing — named on the issue and in Discord */
      failedChecks: FailedCheck[];
    }
  | { type: "clearCiRepair"; runId: string; issueRef: string }
  | {
      // The reviewed commit moved (issue #131): disarm, drop the stale verdict
      // and gate categories, and hand the run back to gate evaluation so the
      // new diff is re-gated and one fresh review pass judges the head that
      // now exists — the same path a repair push already takes.
      type: "invalidateReview";
      runId: string;
      issueRef: string;
      prNumber: number;
      /** Auto-merge armed — disarm before anything else touches the run */
      armed: boolean;
      /** The head the dropped verdict was written about */
      reviewedHeadSha: string;
      /** The head the PR carries now */
      headSha: string;
      /** Which review cycle the re-review spends (reviewCycleCount + 1) */
      cycle: number;
    }
  | {
      // The reviewed commit moved with no review cycle left to spend (issue
      // #131): the loop stops re-reviewing and hands the PR to a human, rather
      // than trading a fresh pass against every push.
      type: "escalateStaleReview";
      runId: string;
      issueRef: string;
      prNumber: number;
      /** Auto-merge armed — disarm before handing to a human */
      armed: boolean;
      /** The head the standing verdict was written about */
      reviewedHeadSha: string;
      /** The head the PR carries now */
      headSha: string;
      /** Cycles spent before giving up — named in the escalation */
      reviewCycleCount: number;
      /** Why the loop stopped: the attempt's review cycles are gone, or the
       * standing review could not be withdrawn (which names a fixable
       * permission problem rather than a spent budget) */
      reason: "cycles-exhausted" | "dismissal-failed";
    }
  | {
      type: "escalate";
      reason: "blocked";
      runId: string;
      taskId: string;
      issueRef: string;
      question: string;
    }
  | {
      // An implement pass finished with neither a PR nor a `BLOCKED:` question:
      // it left nothing to review or merge, so the run would otherwise dangle
      // non-terminal forever and render as a permanent ghost `running` card
      // (issue #106). Drive the run to a terminal (failed) status at pass
      // completion — the branch was pushed after the turn, so any work
      // survives, and the strike counts toward the attempt cap like any other
      // empty attempt. The turn manager is the sole executor: a sweep always
      // passes `completedPasses: []`, so this never fires from a sweep.
      type: "finalizeEmptyPass";
      runId: string;
      taskId: string;
      issueRef: string;
    }
  | {
      // A pass the account's quota refused account-wide (issue #168): the run
      // parks on the window's reset time instead of failing, consuming neither
      // an attempt (the work was never tried) nor an interruption (the platform
      // did not die). The executor tears the container down — a parked
      // container holds memory without holding a slot, which is what wedged the
      // host on 2026-08-04 — and a paused run then waits: resuming is its own
      // ticket. A wall on a *tier-scoped* window degrades instead of pausing
      // (issue #170) — see `degradeRunTier` below.
      type: "pauseRunOnRateLimit";
      runId: string;
      taskId: string;
      /** "owner/repo#n" */
      issueRef: string;
      /** When the refusing window resets — the run's `resumeAfter` */
      resumeAfter: Date;
      /** Which window refused it, verbatim, or null when the event named none */
      limitType: string | null;
    }
  | {
      // A pass refused on a **tier-scoped** window (issue #170): the account
      // still has quota, just not for this tier, so the run steps down the
      // ladder and retries in place rather than waiting out a window that may
      // be seven days long. Like a pause it consumes neither an attempt nor an
      // interruption — the work was never tried — and the executor tears the
      // refused pass's container down and queues a fresh pass of the same kind
      // under the same run.
      type: "degradeRunTier";
      runId: string;
      taskId: string;
      /** "owner/repo#n" */
      issueRef: string;
      /** The tier the refused pass ran at */
      from: ModelTier;
      /** The tier its retry runs at — the first rung below both `from` and the
       * tier the exhausted window names */
      to: ModelTier;
      /** The window that refused it, verbatim. Non-null by construction: a
       * degrade is only ever decided from a window that names a tier */
      limitType: string;
      /** When that window resets, or null when the event named none. Said on
       * the issue for context only — a degrade waits on no clock, which is why
       * a reset-less rejection can still degrade where it could not pause */
      resumeAfter: Date | null;
    }
  | {
      // A pass refused on a window its own lane cannot get past — the bottom of
      // the tier ladder, or an account-wide wall — where **another lane can
      // serve it** (issue #176). The run moves lanes and retries rather than
      // parking for hours beside an idle lane costing a fraction as much.
      //
      // Like a pause and a degrade it consumes neither an attempt nor an
      // interruption, since the work was never tried; unlike a degrade it
      // carries the refused pass's session, so the move is lossless in exactly
      // the way #169's resume is. The target lane is advisory: the replacement
      // pass re-asks the same ranking when it starts, so a wall that lifted in
      // between sends it back to the cheaper lane rather than honouring a
      // stale decision.
      type: "failOverRunLane";
      runId: string;
      taskId: string;
      /** "owner/repo#n" */
      issueRef: string;
      /** The lane that refused the pass; null when the pass recorded none */
      fromLaneId: string | null;
      toLaneId: string;
      toLaneLabel: string;
      /** What running there will cost — `metered` means real money, already
       * checked against #174's cap and confirm-once press by the ranking */
      toLaneBilling: LaneBilling;
      /** The window that refused it, verbatim, or null when it named none */
      limitType: string | null;
      /** When that window resets, or null when the event named none. Said for
       * context only — a lane move waits on no clock, which is why a
       * reset-less wall can move where it could not pause */
      resumeAfter: Date | null;
      /** Which continuation of this attempt the move is, and the bound it
       * counts against — the same pair a resume reports (issue #169) */
      move: number;
      maxMoves: number;
    }
  | {
      // A paused run whose window has reset (issue #169): queue its pass again
      // in a fresh container, on the same branch, continuing the same
      // conversation where the transcript survived the teardown. Consumes no
      // attempt — the pause did not either — but does count against the resume
      // bound, which is what stops a ticket looping across quota windows.
      type: "resumeRun";
      runId: string;
      /** "owner/repo#n" */
      issueRef: string;
      /** Which resume this is (resumesMade + 1) — recorded on the run and
       * named on the issue, so a ticket crossing several windows reads as one
       * attempt rather than as several */
      resume: number;
      /** The bound it is counted against, for the issue comment */
      maxResumes: number;
    }
  | {
      // A run that has paused more often than one attempt may (issue #169):
      // the ticket goes to a human the way an exhausted one does. Deliberately
      // not a failed attempt — the pauses spent none — so a human who re-arms
      // the ticket still gets the attempts it never used.
      type: "exhaustPausedRun";
      runId: string;
      /** "owner/repo#n" */
      issueRef: string;
      /** Resumes spent before giving up — named in the escalation */
      resumesMade: number;
    }
  | {
      type: "startTriage";
      issueRef: string;
      projectId: string;
      issueNumber: number;
      issueTitle: string;
      issueBody: string;
    }
  | {
      type: "applyTriage";
      taskId: string;
      issueRef: string;
      exit: TriageExitKind;
      /** Advisory labels only — fixed per exit kind, drawn from
       * ADVISORY_TRIAGE_LABELS and never from pass output. No exit maps to
       * `ready-for-agent`; the executor refuses anything outside the set. */
      addLabels: string[];
      /** The comment the orchestrator posts on the issue — the assessment,
       * the questions, or the grilling agenda, framed */
      comment: string;
    }
  | {
      type: "notify";
      event: "triage-recommendation";
      payload: {
        taskId: string;
        issueRef: string;
        issueTitle: string;
        projectId: string;
        assessment: string;
        /** The tier the run will use if armed as the issue stands (issue
         * #200) — the body's directive, else triage's suggestion; null means
         * the configured default. Stated on the embed because the suggestion
         * reaches the run without appearing in the body, and the Discord
         * reply is the moment the operator authorizes the work. */
        tier: RunTierChoice;
      };
    }
  | {
      type: "notify";
      event: "triage-unparseable";
      payload: { taskId: string; issueRef: string; reason: string };
    }
  | {
      type: "exhaust";
      issueRef: string;
      attemptsMade: number;
      interruptionsMade: number;
      /** What burnt the ticket: three failed attempts, or the interruption
       * bound — restarts are counted separately and never consume attempts,
       * but past the bound the ticket goes to a human instead of looping */
      reason: "attempts" | "interruptions";
    }
  | {
      type: "failAttempt";
      runId: string;
      issueRef: string;
      prNumber: number;
      armed: boolean;
      reason: "review-cycles-exhausted";
      /** The final review's findings — posted to the PR as the record */
      reviewBody: string;
      /** The head those findings are about (issue #131) */
      headSha: string;
    };

/**
 * A snapshot for deciding one finished pass at the moment its turn ends,
 * outside a sweep: every pickup, gating, review and saturation input is
 * inert, so the only possible decision is about the pass itself.
 */
export function passOutcomeSnapshot(
  now: Date,
  pass: PassOutcome,
  /** The resume/lane-move bound in force (issue #169's setting), which #176's
   * failover counts against. Zero — the default — means no continuation of any
   * kind, so a refused pass pauses exactly as it did before that ticket. */
  maxResumesPerAttempt = 0
): AutonomySnapshot {
  return {
    now,
    autonomyEnabledGlobal: true,
    // The kill switch holds new pickup, never a turn that already ran: a pass
    // finishing while the fleet is paused is still parked-or-proceeded here.
    globalPaused: false,
    attemptBudgetUsd: 0,
    maxAttempts: 0,
    maxInterruptions: 0,
    maxReviewCycles: 0,
    maxUnparseableRetries: 0,
    maxIntegrationAttempts: 0,
    todayAutonomousSpendUsd: 0,
    dailyCapUsd: 0,
    dailyCapAnnounced: true,
    // Inert like every other pickup input: the money guards hold new claims,
    // never a turn that already ran. A subscription billing kind is the one
    // value that decides nothing here.
    primaryLaneId: null,
    primaryLaneBilling: "subscription",
    meteredSpendTodayUsd: 0,
    meteredCapUsd: 0,
    meteredSpendConfirmedAt: null,
    meteredCapAnnounced: true,
    meteredConfirmationAnnounced: true,
    // No pickup is decided here, so the quota gate has nothing to hold: an
    // absent observation is an open gate, and the announcement is marked spent
    // so nothing could be said even if one were reached.
    quota: null,
    quotaThresholdPercent: 100,
    quotaGateAnnounced: true,
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
    conflictingPrs: [],
    resolvedConflicts: [],
    checksFailingPrs: [],
    resolvedCheckFailures: [],
    staleReviews: [],
    maxCiRepairAttempts: 0,
    minCheckFailureSweeps: 0,
    announcedCheckEscalations: [],
    queuedRepairCount: 0,
    announcedIntegrationEscalations: [],
    triageCandidates: [],
    pendingTriageResults: [],
    queuedTriageCount: 0,
    announcedTriageErrors: [],
    // A pass that just ended is not a paused run: the run it belongs to may be
    // *about* to become one, decided below from this very outcome.
    pausedRuns: [],
    // The one bound this path does consult (issue #176): a lane move is a
    // continuation of the attempt, counted against the same number a resume
    // is, so the caller passes the resolved bound rather than an inert zero.
    maxResumesPerAttempt: maxResumesPerAttempt,
    resumeJitterMs: 0,
  };
}

/** Allowed by default: the repo owner; extended by the configured allow-list. */
function isAuthorAllowed(repo: string, author: string, allowedAuthors: string[]): boolean {
  const login = author.toLowerCase();
  const repoOwner = repo.split("/")[0].toLowerCase();
  return login === repoOwner || allowedAuthors.some((a) => a.toLowerCase() === login);
}

/**
 * One sentence naming the tier a run will use and where it came from (issue
 * #200), for the issue comment and the Discord embed. Null names the
 * configured default without guessing which tier that resolves to: the
 * reducer is pure and the default is the executor's to read.
 */
export function describeRunTier(tier: RunTierChoice): string {
  if (tier === null) {
    return "Tier: the configured default — neither the ticket nor triage stated one.";
  }
  return `Tier: \`${tier.tier}\` (${describeTierSource(tier.source)}).`;
}

/** The phrase naming where a run's tier came from — written once, because
 * the recommendation and the claim comment both say it (issue #200). */
export function describeTierSource(source: "ticket" | "triage"): string {
  return source === "ticket"
    ? "ticket directive"
    : "triage's suggestion — the ticket states none; a `model:` line in a Workflow section would outrank it";
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
  // manager proceeds to completion. A run parked by its pass outcome is driven
  // by exactly one thing — its question, its quota clock, or its retry a tier
  // lower (issue #170): the executors
  // never gather such a run into the review pipeline (it leaves the
  // reviewing/gated set), but the combination is representable in a snapshot,
  // so the reducer refuses to double-drive it rather than trusting the callers.
  const parkedRunIds = new Set<string>();
  for (const pass of snapshot.completedPasses) {
    // The quota wall first, ahead of every other reading of the turn (issues
    // #168, #170). A refused pass never reached the model: the "final message"
    // is the CLI's own session-limit line and the empty diff is the wall's, so
    // both the blocked-marker detector and the empty-pass check below would be
    // judging the account's quota as if it were the work.
    if (pass.rateLimited) {
      // Which consequence a wall has is the whole of issue #170, and it turns
      // on one field: the window that refused the pass. A **tier-scoped** one
      // (`seven_day_opus`) leaves the account with quota the fleet can still
      // spend, one rung down, so the run steps down and retries. Only an
      // account-wide window — or the bottom of the ladder, where there is
      // nowhere left to step — actually stops the run.
      const { limitType, resumeAfter } = pass.rateLimited;
      if (limitType !== null) {
        const degrade = planTierDegrade(pass.tier, limitType);
        if (degrade !== null) {
          parkedRunIds.add(pass.runId);
          actions.push({
            type: "degradeRunTier",
            runId: pass.runId,
            taskId: pass.taskId,
            issueRef: pass.issueRef,
            from: degrade.from,
            to: degrade.to,
            limitType,
            resumeAfter,
          });
          continue;
        }
      }
      // Then across lanes (issue #176). The ladder above steps *within* one
      // lane, and it has been asked first because a tier step is free — the
      // account still has quota — where a lane move may cost real money and
      // will certainly cost a fresh conversation's worth of orientation. What
      // is left here is a wall this lane cannot get past: account-wide, or the
      // bottom of its ladder. If another lane can serve the pass, moving beats
      // parking for hours beside it.
      //
      // A move waits on no clock, so — like a degrade, and unlike a pause — a
      // rejection that named no reset time can still take it. That is the case
      // this ticket helps most: before it, such a wall spent one of the
      // ticket's three attempts.
      if (
        pass.laneFailover !== null &&
        // The same counter a resume answers to (issue #169). At the bound the
        // run pauses instead, and that ticket's own exhaustion hands it to a
        // human — so a run cannot thrash across lanes forever, and needs no
        // second counter to say so.
        pass.resumesMade < snapshot.maxResumesPerAttempt
      ) {
        parkedRunIds.add(pass.runId);
        actions.push({
          type: "failOverRunLane",
          runId: pass.runId,
          taskId: pass.taskId,
          issueRef: pass.issueRef,
          fromLaneId: pass.laneId,
          toLaneId: pass.laneFailover.toLaneId,
          toLaneLabel: pass.laneFailover.toLaneLabel,
          toLaneBilling: pass.laneFailover.billing,
          limitType,
          resumeAfter,
          move: pass.resumesMade + 1,
          maxMoves: snapshot.maxResumesPerAttempt,
        });
        continue;
      }
      // A pause needs a clock, and a rejection that named no reset time gives
      // it none. Pausing on an invented one would strand the run where no
      // later ticket can find it, so — exactly as before #170 — such a pass
      // falls through to its ordinary path and spends the attempt.
      if (resumeAfter !== null) {
        parkedRunIds.add(pass.runId);
        actions.push({
          type: "pauseRunOnRateLimit",
          runId: pass.runId,
          taskId: pass.taskId,
          issueRef: pass.issueRef,
          resumeAfter,
          limitType,
        });
        continue;
      }
    }
    const question = detectBlockedQuestion(pass.finalMessage);
    if (question) {
      parkedRunIds.add(pass.runId);
      actions.push({
        type: "escalate",
        reason: "blocked",
        runId: pass.runId,
        taskId: pass.taskId,
        issueRef: pass.issueRef,
        question,
      });
      continue;
    }
    // A pass that ended with neither a PR nor a blocked question left the run
    // with nothing to review or merge. Without this it would sit in
    // `implementing`/`reviewing` indefinitely and render as a permanent ghost
    // `running` card (issue #106) — so finalize the run here, at the same
    // pass-completion seam that parks a blocked run.
    if (!pass.producedPr) {
      actions.push({
        type: "finalizeEmptyPass",
        runId: pass.runId,
        taskId: pass.taskId,
        issueRef: pass.issueRef,
      });
    }
  }

  // Settled PRs first: pure ledger bookkeeping for work that already landed
  // (or was closed by a human) — nothing downstream depends on it this sweep.
  for (const settled of snapshot.settledPrs) {
    if (parkedRunIds.has(settled.runId)) continue;
    actions.push({
      type: "finalizeRun",
      runId: settled.runId,
      issueRef: settled.issueRef,
      prNumber: settled.prNumber,
      outcome: settled.merged ? "merged" : "closed",
    });
  }

  // Parked PRs the tracker reports CONFLICTING (issue #54): a human merge
  // elsewhere moved the default branch under a reviewing/gated run. Left
  // unnoticed this is an invisible stall, so each conflict drives an
  // integration repair — a fresh container that merges the default branch in
  // (merge only) and lets the normal gate + review machinery re-run on push.
  // A repair never consumes an attempt; once repairs are spent and the PR is
  // still CONFLICTING the run escalates to a human, announced once. A PR whose
  // mergeability is still `unknown` never reaches this list — it is re-polled.
  let repairsQueuedThisSweep = 0;
  for (const conflicting of snapshot.conflictingPrs) {
    if (parkedRunIds.has(conflicting.runId)) continue;
    if (conflicting.integrationsMade >= snapshot.maxIntegrationAttempts) {
      if (!snapshot.announcedIntegrationEscalations.includes(conflicting.runId)) {
        actions.push({
          type: "escalateConflict",
          runId: conflicting.runId,
          issueRef: conflicting.issueRef,
          prNumber: conflicting.prNumber,
          armed: conflicting.armed,
          integrationsMade: conflicting.integrationsMade,
        });
      }
      continue;
    }
    if (conflicting.hasRepairTask) continue; // a repair is already in flight
    repairsQueuedThisSweep++;
    actions.push({
      type: "repairPr",
      runId: conflicting.runId,
      issueRef: conflicting.issueRef,
      prNumber: conflicting.prNumber,
      integration: conflicting.integrationsMade + 1,
    });
  }

  // A parked run whose PR is mergeable again after a conflict: end the episode
  // so a later, unrelated conflict earns its own repairs rather than being
  // judged against a stale count.
  for (const resolved of snapshot.resolvedConflicts) {
    if (parkedRunIds.has(resolved.runId)) continue;
    actions.push({
      type: "clearIntegration",
      runId: resolved.runId,
      issueRef: resolved.issueRef,
    });
  }

  // Parked PRs whose checks are red (issue #130) — the merge is textually clean
  // but the branch does not build, which is how a changed API meets a new caller
  // added on the default branch. Same skeleton as the conflict branch above: a
  // bounded CI-repair pass in a fresh container, never charged against
  // MAX_ATTEMPTS, then escalation to a human once the repairs are spent. The
  // repair runs whether or not auto-merge is armed — a gated PR with red checks
  // is equally stuck (settled decision), and the human still owns the merge.
  // Ordering against #131: CI is repaired first and any re-review happens once
  // the rollup is green, so no review pass is ever queued against a branch that
  // does not compile.
  for (const failing of snapshot.checksFailingPrs) {
    if (parkedRunIds.has(failing.runId)) continue;
    // The flake guard: a red rollup must be seen on consecutive sweeps before
    // it costs anything at all — neither a repair nor an escalation.
    if (failing.sweepsFailing < snapshot.minCheckFailureSweeps) continue;
    if (failing.ciRepairsMade >= snapshot.maxCiRepairAttempts) {
      if (!snapshot.announcedCheckEscalations.includes(failing.runId)) {
        actions.push({
          type: "escalateChecks",
          runId: failing.runId,
          issueRef: failing.issueRef,
          prNumber: failing.prNumber,
          armed: failing.armed,
          ciRepairsMade: failing.ciRepairsMade,
          failedChecks: failing.failedChecks,
        });
      }
      continue;
    }
    if (failing.hasRepairTask) continue; // a repair is already in flight
    // Both repair kinds queue a `repair` task, so they share the slot count.
    repairsQueuedThisSweep++;
    actions.push({
      type: "repairChecks",
      runId: failing.runId,
      issueRef: failing.issueRef,
      prNumber: failing.prNumber,
      headSha: failing.headSha,
      failedChecks: failing.failedChecks,
      ciRepair: failing.ciRepairsMade + 1,
    });
  }

  // A parked run whose rollup is green again after a CI-repair episode: reset
  // the counter so a later, unrelated failure earns its own repair.
  for (const resolved of snapshot.resolvedCheckFailures) {
    if (parkedRunIds.has(resolved.runId)) continue;
    actions.push({
      type: "clearCiRepair",
      runId: resolved.runId,
      issueRef: resolved.issueRef,
    });
  }

  // A parked run whose PR head has moved past the commit its posted verdict was
  // written about (issue #131). Only the loop's own repair path used to
  // invalidate a verdict; any other push — a human's *Update branch*, a commit,
  // a main merge — left the approval standing over code nobody reviewed, and an
  // armed run would merge it. Sits after the CI branches on purpose: the settled
  // ordering (#130) is repair the build first, re-review once the rollup is
  // green, so no review pass is ever queued against a branch that does not
  // compile.
  for (const stale of snapshot.staleReviews) {
    if (parkedRunIds.has(stale.runId)) continue;
    // Two ways a moved head stops being re-reviewable. A withdrawal GitHub
    // refused is checked first: it names a fixable permission problem, and the
    // loop must not re-arm over a review it could not remove. Otherwise the
    // bound — a re-review costs a cycle like the fix-up a request-changes buys,
    // and past the budget the run goes to a human rather than trading a review
    // pass against every push.
    const cyclesSpent = stale.reviewCycleCount + 1 >= snapshot.maxReviewCycles;
    if (stale.dismissalFailed || cyclesSpent) {
      actions.push({
        type: "escalateStaleReview",
        runId: stale.runId,
        issueRef: stale.issueRef,
        prNumber: stale.prNumber,
        armed: stale.armed,
        reviewedHeadSha: stale.reviewedHeadSha,
        headSha: stale.headSha,
        reviewCycleCount: stale.reviewCycleCount,
        reason: stale.dismissalFailed ? "dismissal-failed" : "cycles-exhausted",
      });
      continue;
    }
    actions.push({
      type: "invalidateReview",
      runId: stale.runId,
      issueRef: stale.issueRef,
      prNumber: stale.prNumber,
      armed: stale.armed,
      reviewedHeadSha: stale.reviewedHeadSha,
      headSha: stale.headSha,
      cycle: stale.reviewCycleCount + 1,
    });
  }

  // Triage exits next: comment-and-advisory-label bookkeeping for passes
  // that already ran, needing no slot. The label set is derived from the
  // exit kind alone — recommend applies nothing (arming stays with a human),
  // needs-info and ready-for-human apply exactly their own label. No mapping
  // to ready-for-agent exists, so no pass output can reach it. An
  // unparseable exit fails closed: announced once, nothing applied, and the
  // issue keeps `needs-triage` so a human sees it in the tracker.
  for (const pending of snapshot.pendingTriageResults) {
    const { result } = pending;

    if (result.kind === "unparseable") {
      if (!snapshot.announcedTriageErrors.includes(pending.taskId)) {
        actions.push({
          type: "notify",
          event: "triage-unparseable",
          payload: {
            taskId: pending.taskId,
            issueRef: pending.issueRef,
            reason: result.reason,
          },
        });
      }
      continue;
    }

    if (result.kind === "recommend") {
      // The tier the run will use if armed as the issue stands (issue #200),
      // under the same precedence the claim applies below — the body's own
      // directive outranks the pass's suggestion. Named on both surfaces the
      // operator authorizes from (the issue comment for a label click, the
      // embed for a Discord "yes") because the suggestion reaches the run
      // without ever appearing in the body.
      const tier = chooseRunTier(parseTicketDirectives(pending.issueBody).model, result.tier);
      actions.push({
        type: "applyTriage",
        taskId: pending.taskId,
        issueRef: pending.issueRef,
        exit: "recommend",
        addLabels: [],
        comment:
          `Triage assessment — recommended for arming:\n\n${result.body}\n\n` +
          `${describeRunTier(tier)}\n\n` +
          `Arming stays with a human: apply \`ready-for-agent\` to launch, ` +
          `or confirm the Discord recommendation with a reply of "yes".`,
      });
      actions.push({
        type: "notify",
        event: "triage-recommendation",
        payload: {
          taskId: pending.taskId,
          issueRef: pending.issueRef,
          issueTitle: pending.issueTitle,
          projectId: pending.projectId,
          assessment: result.body,
          tier,
        },
      });
    } else if (result.kind === "needs-info") {
      actions.push({
        type: "applyTriage",
        taskId: pending.taskId,
        issueRef: pending.issueRef,
        exit: "needs-info",
        addLabels: [NEEDS_INFO_LABEL],
        comment:
          `Triage: this needs more information before it can be armed — ` +
          `labelled \`${NEEDS_INFO_LABEL}\`.\n\n${result.body}`,
      });
    } else {
      actions.push({
        type: "applyTriage",
        taskId: pending.taskId,
        issueRef: pending.issueRef,
        exit: "ready-for-human",
        addLabels: [READY_FOR_HUMAN_LABEL],
        comment:
          `Triage: this needs a grilling session before anyone writes code — ` +
          `labelled \`${READY_FOR_HUMAN_LABEL}\`.\n\n${result.body}`,
      });
    }
  }

  // Verdicts next — in-flight work outranks everything else, and a fix-up
  // turn resumes a parked container, so it takes a free slot ahead of any
  // reservation below. A request-changes with no slot free is held whole
  // (review post and fix-up together) for a later sweep: posting the review
  // without delivering the feedback would strand the run mid-cycle.
  let slotsLeft = Math.max(0, snapshot.slots.total - snapshot.slots.occupied);
  // A re-queued review reserves the slot it will draw exactly as a first
  // review does, so it is counted with the fresh reviews below when new claims
  // work out how many slots remain.
  let reviewsQueuedThisSweep = 0;
  for (const pending of snapshot.pendingVerdicts) {
    if (parkedRunIds.has(pending.runId)) continue;
    const { result } = pending;

    if (result.kind === "unparseable") {
      // A pure format slip is the common cause — a substantively fine review
      // whose final message just didn't lead with a VERDICT: line — so the
      // pass earns one bounded re-queue with the parse failure fed back before
      // anyone is paged (issue #89). Like a first review, this reserves intent,
      // not a slot: the queue applies the capacity check when it starts.
      if (pending.reviewUnparseableCount < snapshot.maxUnparseableRetries) {
        reviewsQueuedThisSweep++;
        actions.push({
          type: "retryReview",
          runId: pending.runId,
          issueRef: pending.issueRef,
          prNumber: pending.prNumber,
          armed: pending.armed,
          parseFailure: result.reason,
        });
        continue;
      }
      // Retries spent: the fail-closed case. No review is posted, nothing is
      // armed, the owner is told (once). The executor disarms and adds human
      // oversight, leaving the stored result in place as the record.
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
      // Cycle 1 is the initial implement+review; each request-changes buys
      // one more. A verdict that would need a cycle past the bound fails the
      // attempt — the findings still land on the PR, but no fix-up runs, and
      // the failed run counts a strike. Checked before the container-gone
      // escalation: the bound binds whether or not a fix-up is deliverable.
      if (pending.reviewCycleCount + 1 >= snapshot.maxReviewCycles) {
        actions.push({
          type: "failAttempt",
          runId: pending.runId,
          issueRef: pending.issueRef,
          prNumber: pending.prNumber,
          armed: pending.armed,
          reason: "review-cycles-exhausted",
          reviewBody: result.body,
          headSha: pending.headSha,
        });
        continue;
      }
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
          headSha: pending.headSha,
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
        headSha: pending.headSha,
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
      headSha: pending.headSha,
    });
  }

  // Paused runs next (issue #169) — before review pickup and well before any
  // claim, because resuming existing work outranks starting new work: a run
  // parked on the quota clock already holds its ticket, has a branch with work
  // on it, and is one pass from a PR, while a claim is all of that still to
  // buy. Each resume reserves a slot against new claims exactly as a queued
  // review does (see claimableSlots below).
  //
  // Deliberately *not* held by the daily cap or the kill switch. Both of those
  // gate pickup — "no claim, no triage pass" — and everything already in
  // flight is decided regardless: a verdict is posted, a fix-up turn is
  // delivered, a conflict is repaired. A paused run is in flight; it is the
  // middle of an attempt the fleet already started, and abandoning it at a
  // window boundary would spend the very attempt the pause protected.
  let resumesQueuedThisSweep = 0;
  for (const paused of snapshot.pausedRuns) {
    if (parkedRunIds.has(paused.runId)) continue;
    // Already resuming — a queued or running task of this run *is* the resume
    // — so the run is not up for a decision at all. First, ahead of the bound
    // as well as the clock: a resume is counted when it is queued, so the run
    // whose last permitted resume is in flight reads as spent while its pass
    // is still starting, and judging the bound here would cancel the very pass
    // just queued.
    if (paused.hasLiveTask) continue;
    // The bound before the clock, on purpose: a run with no resumes left is
    // never going to resume, so making it wait out a five-hour window first
    // would only delay telling the human it is theirs.
    if (paused.resumesMade >= snapshot.maxResumesPerAttempt) {
      actions.push({
        type: "exhaustPausedRun",
        runId: paused.runId,
        issueRef: paused.issueRef,
        resumesMade: paused.resumesMade,
      });
      continue;
    }
    if (
      paused.resumeAfter !== null &&
      snapshot.now <
        resumeEligibleAt(paused.runId, paused.resumeAfter, snapshot.resumeJitterMs)
    ) {
      continue;
    }
    resumesQueuedThisSweep++;
    actions.push({
      type: "resumeRun",
      runId: paused.runId,
      issueRef: paused.issueRef,
      resume: paused.resumesMade + 1,
      maxResumes: snapshot.maxResumesPerAttempt,
    });
  }

  // Review passes are queued before gate decisions and claims: they finish
  // work already in flight. The queue starts them under the ordinary
  // capacity check, so emitting one here only reserves intent, not a slot.
  // (reviewsQueuedThisSweep was seeded above by any unparseable re-queues.)
  for (const awaiting of snapshot.awaitingReview) {
    if (parkedRunIds.has(awaiting.runId)) continue;
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
    // The supervised branch (issue #20): a checkpoint: directive forces
    // human-signoff whatever the globs said — the matched categories are
    // still recorded, but auto-merge is never armed. Supervised is a mode,
    // not a status: the outcome is the ordinary gated path.
    if (categories.length > 0 || pending.checkpoint !== null) {
      actions.push({
        type: "gatePr",
        runId: pending.runId,
        issueRef: pending.issueRef,
        prNumber: pending.prNumber,
        categories,
        checkpoint: pending.checkpoint,
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

  // Triage pickup: a stray needs-triage issue gets its short, cheap pass.
  // Emitted before new claims — shaping the backlog outranks starting more
  // implement work — but after everything in flight; the queue starts the
  // task under the ordinary capacity check, so emitting here reserves
  // intent, not a slot. Skipped wholesale once the daily cap is reached:
  // triage spend is autonomous spend. Skipped for the same reason while the
  // global kill switch is engaged (issue #118) — a triage pass is autonomous
  // pickup that takes a container and spends money, so "stop the fleet" stops
  // it too — and, for that same reason, while the quota gate is closed
  // (issue #171): a pass that cannot finish is not worth starting whatever it
  // costs. Registered is the only project gate — triage writes no code and
  // pushes nothing, so pickup preflight does not apply — and the author
  // allow-list bounds whose issues can spend triage money.
  //
  // The money guards (issue #174) are evaluated once for the whole tick, from
  // the billing kind of the lane a pass would run on, because both pickup
  // gates below consult them. `hold` is null on a subscription lane, on an
  // unresolvable one, and on a metered lane confirmed today and still inside
  // its cash cap.
  const metered = evaluateMeteredSpend({
    billing: snapshot.primaryLaneBilling,
    spentUsd: snapshot.meteredSpendTodayUsd,
    capUsd: snapshot.meteredCapUsd,
    confirmedAt: snapshot.meteredSpendConfirmedAt,
    now: snapshot.now,
  });

  // The quota admission gate (issue #171), evaluated once and consulted twice
  // — here for triage and below for claims — so the fleet cannot hold one kind
  // of pickup and start the other on the same tick. Everything above this line
  // is work already in flight and is deliberately unaffected: refusing to
  // *finish* a run would waste the quota already spent on it, and a parked run
  // resuming is that same work continuing.
  const quotaGate = evaluateQuotaGate(
    snapshot.quota,
    snapshot.quotaThresholdPercent,
    snapshot.now
  );

  let triagesQueuedThisSweep = 0;
  if (
    !snapshot.globalPaused &&
    !quotaGate.closed &&
    snapshot.todayAutonomousSpendUsd < snapshot.dailyCapUsd &&
    // Held by the money guards for the same reason the daily cap holds it: a
    // triage pass takes a container and spends money, and on a metered lane
    // that money is cash. Autonomous work on a metered primary is explicitly
    // allowed — it is bounded here, not exempted.
    metered.hold === null
  ) {
    for (const candidate of snapshot.triageCandidates) {
      if (candidate.hasTriageTask) continue;
      const project = snapshot.projects.find((p) => p.repo === candidate.repo);
      if (!project) continue;
      if (!isAuthorAllowed(candidate.repo, candidate.author, snapshot.allowedAuthors)) {
        continue;
      }
      triagesQueuedThisSweep++;
      actions.push({
        type: "startTriage",
        issueRef: candidate.issueRef,
        projectId: project.id,
        issueNumber: candidate.number,
        issueTitle: candidate.title,
        issueBody: candidate.body,
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
    if (candidate.hasActiveRun) continue;
    // Three strikes: the ticket goes back to a human instead of looping. The
    // executor's label swap (ready-for-agent -> ready-for-human) removes the
    // issue from the candidate set, which is what makes this once. Emitted
    // ahead of the author and blocker checks — routing a burnt ticket back
    // to a human is bookkeeping, not pickup.
    if (candidate.attemptsMade >= snapshot.maxAttempts) {
      actions.push({
        type: "exhaust",
        issueRef: candidate.issueRef,
        attemptsMade: candidate.attemptsMade,
        interruptionsMade: candidate.interruptionsMade,
        reason: "attempts",
      });
      continue;
    }
    // The interruption bound, checked after (and independently of) attempts:
    // a run lost to an orchestrator restart is re-claimed without consuming
    // an attempt — the platform's downtime is not the ticket's fault — but a
    // ticket that crashes the orchestrator on every claim would loop
    // forever on that exemption, so re-claims are bounded separately.
    if (candidate.interruptionsMade >= snapshot.maxInterruptions) {
      actions.push({
        type: "exhaust",
        issueRef: candidate.issueRef,
        attemptsMade: candidate.attemptsMade,
        interruptionsMade: candidate.interruptionsMade,
        reason: "interruptions",
      });
      continue;
    }
    if (!isAuthorAllowed(candidate.repo, candidate.author, snapshot.allowedAuthors)) continue;
    if (candidate.hasOpenBlocker) continue;
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

  // The daily cap pauses pickup and nothing else: in-flight work above still
  // ran, exhaust bookkeeping still routed, interactive tasks never counted.
  // Spend is attributed to the day a run was claimed and the sum starts at
  // local midnight, so the pause lifts with the new day. Announced once.
  if (snapshot.todayAutonomousSpendUsd >= snapshot.dailyCapUsd) {
    if (!snapshot.dailyCapAnnounced) {
      actions.push({
        type: "notify",
        event: "daily-cap-reached",
        payload: {
          spentUsd: snapshot.todayAutonomousSpendUsd,
          capUsd: snapshot.dailyCapUsd,
        },
      });
    }
    actions.push({ type: "pausePickup", reason: "daily-cap" });
    return actions;
  }

  // The real-money cap (issue #174): the second cap feeding the mechanism
  // directly above, keyed off the resolved lane's billing kind rather than off
  // an overflow that may never have happened. Same pause reason — this is one
  // hold with two causes, and the detail names which — but its own
  // announcement, because "the card has been charged $X" is different news
  // from "the fleet worked hard today". Subscription work never reaches here:
  // `metered.hold` is null unless the lane bills per token, which is what
  // "the cap measures money, not quota" means in code.
  if (metered.hold === "cap-reached") {
    if (!snapshot.meteredCapAnnounced) {
      actions.push({
        type: "notify",
        event: "metered-cap-reached",
        payload: {
          spentUsd: metered.spentUsd,
          capUsd: metered.capUsd,
          laneId: snapshot.primaryLaneId,
        },
      });
    }
    actions.push({
      type: "pausePickup",
      reason: "daily-cap",
      detail:
        `real-money cap: $${metered.spentUsd.toFixed(2)} of ` +
        `$${metered.capUsd.toFixed(2)} spent on ${snapshot.primaryLaneId ?? "a metered lane"}`,
    });
    return actions;
  }

  // The operator's global kill switch (issue #118), read from the settings row
  // each tick. It sits beside the env master far above — that one stops sweeps
  // from ever starting, this one stops what a running sweep would claim, at the
  // next tick and with no restart. Placed here, at the cap's own gate, so the
  // two paused fleets behave identically: everything in flight was already
  // decided above (verdicts, gate decisions, repairs, review passes), a burnt
  // ticket still routes back to a human, a running turn is left to finish, and
  // only new claims stop. Triage pickup is held by the same flag further up.
  // When both holds apply the cap returns first, so the cap is what the sweep
  // logs and announces (that announcement must not be swallowed by a switch);
  // the dashboard names the switch instead, being the hold a human can lift.
  if (snapshot.globalPaused) {
    actions.push({ type: "pausePickup", reason: "kill-switch" });
    return actions;
  }

  // The confirm-once gate. A fleet-level press, not a per-session one: nobody
  // is at the keyboard when an autonomous pass crosses into billing. Once
  // given it stands for the local day, so the second claim of the day and
  // every one after it proceeds automatically until the cap above.
  //
  // Below the kill switch, unlike its own cap directly above: this one *asks
  // for a press*, and asking under a switch a human has engaged would point
  // them at a control that would change nothing — the same reasoning the quota
  // gate below is placed here for. The cap stays above because its
  // announcement is news either way, exactly as the daily cap's is.
  if (metered.hold === "unconfirmed") {
    if (!snapshot.meteredConfirmationAnnounced) {
      actions.push({
        type: "notify",
        event: "metered-confirmation-required",
        payload: { capUsd: metered.capUsd, laneId: snapshot.primaryLaneId },
      });
    }
    actions.push({
      type: "pausePickup",
      reason: "metered-unconfirmed",
      detail: `${snapshot.primaryLaneId ?? "the primary lane"} bills real money — today's spend is unconfirmed`,
    });
    return actions;
  }

  // The quota admission gate (issue #171). Placed after the switch because the
  // ticket is explicit that a human's hold outranks an observation — under an
  // engaged switch nothing would be claimed anyway, and naming quota there
  // would point the owner at a wall instead of at the control they hold — and
  // before the slot check because "we are out of quota" is the more useful of
  // the two answers when both are true: a full box empties by itself in
  // minutes, a spent window does not.
  //
  // Announced once per transition, like saturation and the cap: the executor
  // holds the flag and clears it the moment the gate opens. And announced only
  // from here, past the eligibility filter, which is what makes the ping mean
  // "the fleet is stalled on quota" rather than "a run paused" — there is
  // armed, eligible work that would otherwise be claimed right now.
  if (quotaGate.closed) {
    if (!snapshot.quotaGateAnnounced) {
      actions.push({
        type: "notify",
        event: "quota-gate-closed",
        payload: {
          status: quotaGate.status ?? "rejected",
          rateLimitType: quotaGate.rateLimitType,
          utilization: quotaGate.utilization,
          thresholdPercent: quotaGate.thresholdPercent,
          reason: quotaGate.reason ?? "rejected",
          resetsAt: quotaGate.resetsAt,
          heldTickets: eligible.length,
        },
      });
    }
    actions.push({ type: "pausePickup", reason: "quota-gate" });
    return actions;
  }

  // Priority order: in-flight work already holds its slot (it is counted in
  // `occupied`, and a fix-up turn delivered above decremented `slotsLeft`),
  // a queued interactive task reserves the next free slot, an
  // already-claimed implement task or a queued review, repair or triage pass
  // reserves the slot it is waiting for, and only what remains may go to new
  // autonomous claims.
  const claimableSlots = Math.max(
    0,
    slotsLeft -
      snapshot.queuedInteractiveCount -
      snapshot.queuedImplementCount -
      snapshot.queuedReviewCount -
      reviewsQueuedThisSweep -
      snapshot.queuedRepairCount -
      repairsQueuedThisSweep -
      snapshot.queuedTriageCount -
      triagesQueuedThisSweep -
      // A resumed run's pass is queued work like any other, and it is the one
      // the ticket asks to be preferred: subtracting it here is what makes
      // "resuming existing work outranks claiming new work" true when slots
      // are scarce, rather than a matter of which action happens to be
      // executed first.
      resumesQueuedThisSweep
  );

  if (claimableSlots === 0) {
    actions.push({ type: "pausePickup", reason: "no-slots" });
    return actions;
  }

  for (const { candidate, project } of eligible.slice(0, claimableSlots)) {
    // Directives are the ticket adjusting its own bounded numbers — parsed
    // from the Workflow section only, already clamped to the ceilings.
    const directives = parseTicketDirectives(candidate.body);
    // The run's tier (issue #200): the body's directive, else the tier the
    // issue's triage pass suggested. Triage fills the gap and never overrides
    // it — a pass that read the ticket cold may not overrule what the
    // operator wrote — and with neither the run keeps its configured default
    // exactly as an untiered ticket always has.
    const tier = chooseRunTier(directives.model, candidate.triageTier);
    actions.push({
      type: "claimIssue",
      issueRef: candidate.issueRef,
      projectId: project.id,
      issueNumber: candidate.number,
      issueTitle: candidate.title,
      issueBody: candidate.body,
      attempt: candidate.attemptsMade + 1,
      mode: directives.checkpoint !== null ? "supervised" : "autonomous",
      budgetUsd: directives.budget ?? snapshot.attemptBudgetUsd,
      checkpoint: directives.checkpoint,
      maxTurns: directives.maxTurns,
      model: tier?.tier ?? null,
      modelSource: tier?.source ?? null,
      effort: directives.effort,
      workflow: selectWorkflow(candidate.body, candidate.labels),
    });
  }

  return actions;
}
