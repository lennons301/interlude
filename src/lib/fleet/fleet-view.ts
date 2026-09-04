/**
 * The fleet read model (Phase 5, issue #21). `buildFleetView(rows)` is pure:
 * every row it depends on is passed in — including `now` — so the dashboard
 * and the daily digest render one shared, table-testable structure and can
 * never disagree about the state of the fleet.
 */

import {
  DEFAULT_REVIEW_BUDGET_USD,
  DEFAULT_TRIAGE_BUDGET_USD,
  MAX_ATTEMPTS,
  MAX_CI_REPAIR_ATTEMPTS,
  MAX_INTEGRATION_ATTEMPTS,
  RESUME_JITTER_WINDOW_MS,
} from "../orchestrator/autonomy/budgets";
import { resumeEligibleAt } from "../orchestrator/autonomy/resume-jitter";
import { formatDuration, type FleetHealthSignals } from "./health";
import type { LaneBilling } from "../lanes/lane-config";
import { evaluateMeteredSpend, type MeteredHold } from "../lanes/money";
import {
  describeRateLimitType,
  quotaSeverity,
  type QuotaObservation,
  type QuotaSeverity,
} from "../quota/rate-limit-event";
import { evaluateQuotaGate } from "../quota/quota-gate";
import { MODEL_TIERS, normalizeModelTier } from "../model-tiers";

export interface FleetRows {
  /** Current time — passed in, never read inside */
  now: Date;
  /** Total agent slots, from the boot-time capacity derivation */
  slots: number;
  /** Daily estate-wide autonomous spend cap in USD */
  dailyCapUsd: number;
  /** The real-money daily cap in force (issue #174): the operator's dial,
   * bound down by the primary lane's own declared cap. */
  meteredCapUsd: number;
  /** Real money spent on the local day containing `now`, from the per-day
   * ledger (`todayMeteredSpendUsd`) rather than summed here. Passed in for the
   * reason the cap is: it is the *same* number the reducer gates on, and a
   * second implementation of "what has the card been charged today?" would
   * eventually disagree with the first. A task's stored cost is a running
   * total carrying no day, so it cannot be attributed to one here anyway. */
  meteredSpendTodayUsd: number;
  /** The id of the lane work would run on; null = none resolves. */
  primaryLaneId: string | null;
  /** Who pays for that lane. Null = it could not be resolved, which is not a
   * money hold — such a fleet spends nothing, since every pass refuses to
   * start. */
  primaryLaneBilling: LaneBilling | null;
  /** Whether an **overage** is what is being billed rather than the lane
   * itself (issue #173) — already the shared predicate, not the raw
   * observation, so a card cannot accuse a subscription lane of billing per
   * token or describe a metered lane as an overage. */
  primaryLaneOverage: boolean;
  /** When the fleet last confirmed it may spend real money; null = never. The
   * view judges it against `now`, exactly as the reducer does. */
  meteredSpendConfirmedAt: Date | null;
  /** The global kill switch (issue #118), from the durable settings row: while
   * engaged the sweep claims nothing new, so the dashboard has to say so — a
   * held fleet and an idle one look identical otherwise */
  globalAutonomyPaused: boolean;
  /** The env boot master `AUTONOMY_ENABLED` (issue #148), fixed at boot: false
   * and no sweep starts at all, so nothing anywhere can be picked up however
   * the runtime holds read. Carried here because the surfaces were otherwise
   * blind to it — a fleet with autonomy off at boot rendered as a running one.
   * Distinct from `globalAutonomyPaused` in what lifts it: a config change and
   * a restart, not a press on /settings. */
  autonomyEnabledAtBoot: boolean;
  /** Discord guild for deep links into project channels; null = no Discord */
  discordGuildId: string | null;
  projects: FleetProjectRow[];
  runs: FleetRunRow[];
  tasks: FleetTaskRow[];
  /** Tickets armed `ready-for-agent` and not yet claimed, keyed by project
   * id — the sweep's last tracker observation; null = never observed */
  backlogByProject: Record<string, number> | null;
  /** Open `ready-for-human` issue refs, keyed by project id — the sweep's last
   * tracker observation of tickets still awaiting a human. An exhausted run
   * whose project was observed but whose issue is absent has been dealt with
   * (closed, or the label dropped) and stops needing you. null = never
   * observed; a project absent from the map = not yet observed (both fall back
   * to the 7-day window). See {@link buildFleetView}'s exhausted filter. */
  needsHumanByProject: Record<string, string[]> | null;
  /** The sweep's last fleet-health evaluation (issue #126) — owed-review
   * stalls, a wedged pickup, a stale queue heartbeat. null = never evaluated
   * (no sweep yet), which renders no health cards. Computed by the sweep, not
   * derivable from DB rows alone (it needs live orchestrator state: the queue
   * heartbeat and occupied-vs-total slots), so it arrives via a store like the
   * backlog/needs-human observations. */
  fleetHealth: FleetHealthSignals | null;
  /** Failing check names keyed by run id (issue #130) — the sweep's last rollup
   * observation for each parked PR it saw red. A run absent from the map has no
   * red rollup right now, so a spent CI-repair counter alone never raises a card
   * (the window after a repair pushes, while the new head's checks run, is not a
   * stall). null = never observed (no sweep yet), which renders no such cards. */
  failingChecksByRun: Record<string, string[]> | null;
  /** The utilization at or above which no new ticket is claimed (issue #171),
   * resolved through the same override / environment / default chain the sweep
   * reads, so the banner and the reducer judge the same observation against the
   * same number. */
  quotaThresholdPercent: number;
  /** The **primary lane's** last observed quota state (issue #167, per-lane
   * since #175), from the durable row; null = no pass on that lane has ever
   * reported one, which is also the permanent state of every metered lane,
   * where the provider emits no quota telemetry at all. */
  quota: QuotaObservation | null;
  /** The lane work would run on right now (issue #175) — what the quota above
   * is an observation *of*, and what a missing observation means. null when no
   * lane resolves (an unusable `lanes.yaml`), which is its own kind of quiet. */
  quotaLane: FleetLaneRow | null;
}

/**
 * The primary execution lane, as much of it as the dashboard needs (issue
 * #175).
 *
 * Deliberately three fields and no credential: this crosses an API route, and
 * a lane's auth is variable *names* even on the settings screen.
 */
export interface FleetLaneRow {
  id: string;
  label: string;
  /** Which billing posture — and so, whether quota telemetry is even possible.
   * The unified-window machinery is subscription-only (#165), so `metered` is
   * exactly the set of lanes for which "no observation" is permanent rather
   * than pending. */
  billing: LaneBilling;
}

export interface FleetProjectRow {
  id: string;
  name: string;
  autonomyEnabled: boolean;
  preflightStatus: "passing" | "failing" | null;
  preflightReason: string | null;
  discordChannelId: string | null;
}

export interface FleetRunRow {
  id: string;
  projectId: string;
  githubIssue: string; // owner/repo#n
  attempt: number;
  mode: "autonomous" | "supervised";
  status:
    | "claimed"
    | "implementing"
    | "reviewing"
    | "gated"
    | "blocked"
    | "merged"
    | "failed"
    | "exhausted"
    | "interrupted"
    /** Parked on the account's quota clock (issue #168) — not a failure, and
     * not finished: the pass was refused on the account-wide rate-limit window
     * and waits for `resumeAfter`. */
    | "rate_limited"
    | "cancelled";
  budgetUsd: number;
  totalCostUsd: number;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  blockedQuestion: string | null;
  /** Integration repairs spent this conflict episode (issue #54): a gated run
   * at or past MAX_INTEGRATION_ATTEMPTS is a stalled merge conflict, not a
   * plain sign-off */
  integrationCount: number;
  /** CI repairs spent this failing-checks episode (issue #130): a gated run at
   * or past MAX_CI_REPAIR_ATTEMPTS whose rollup is still observed red is a
   * stalled red build, not a plain sign-off */
  ciRepairCount: number;
  /** The last verdict the orchestrator POSTED to GitHub for this run. A gated
   * run is a sign-off wait only once this is `approve` (the PR is one human
   * merge away) or `escalate` (the reviewer handed it to a human); until then
   * its review is still in flight (issue #90). */
  reviewVerdict: "approve" | "request-changes" | "escalate" | null;
  /** A finished review pass's parsed output, held until the orchestrator acts.
   * A stored `unparseable` result is terminal by design: the review couldn't be
   * read, the run is parked for a human, and it reads as its own needs-you
   * cause rather than an ordinary sign-off (issue #90). */
  reviewResult:
    | { kind: "approve" | "request-changes" | "escalate"; body: string }
    | { kind: "unparseable"; reason: string }
    | null;
  /** When a `rate_limited` run's window resets (issue #168) — the "resumes in"
   * the paused card shows. Null on every other status. */
  resumeAfter: Date | null;
  /** The tier the run is actually running at (issue #170) — `runs.model`. A
   * pinned raw model id or an unconfigured default is null. */
  model: string | null;
  /** The tier the run was asked for, once the degrade ladder has stepped it off
   * that tier (issue #170); null while it is still running at the tier it was
   * given. */
  degradedFrom: string | null;
  /** The tier the ticket's Workflow section declared at claim (issue #198), or
   * null when it declared none — `runs.declaredTier`. Never `model`: the
   * implement pass writes the resolved tier there, after which a default and a
   * declaration read the same. */
  declaredTier: string | null;
  claimedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** Generation-session skills (issue #61) — kept as a decoupled union here, in
 * step with the row types the view defines rather than importing from the DB
 * schema. Its single runtime source of truth is SESSION_SKILLS in the schema. */
export type SessionSkill =
  | "grill-me"
  | "grill-with-docs"
  | "triage"
  | "to-spec"
  | "to-tickets"
  | "wayfinder";

export interface FleetTaskRow {
  id: string;
  projectId: string;
  runId: string | null;
  kind: "interactive" | "implement" | "review" | "triage" | "repair";
  /** Non-null marks an interactive task as a generation session (issue #61) */
  sessionSkill: SessionSkill | null;
  /** GitHub issue the session is anchored to (owner/repo#n), or null */
  sessionIssue: string | null;
  title: string;
  status: "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled";
  containerStatus: "setup" | "running" | "idle" | "completing" | null;
  totalCostUsd: number;
  /** Claude turns run so far — counted by the caller from delivered messages */
  turns: number;
  githubIssue: string | null;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The real-money half of the spend tile (issue #174). Rendered whenever the
 * fleet is on a metered lane *or* has spent cash today, so a day that ran on
 * OpenRouter this morning and moved back to the subscription still shows what
 * it cost.
 */
export interface MeteredSpendView {
  /** Whether the lane in force bills per token — i.e. whether more cash is
   * about to be spent, as opposed to merely having been. */
  active: boolean;
  /** The lane in force, for the line that names it. */
  laneId: string | null;
  todayUsd: number;
  capUsd: number;
  capPaused: boolean;
  /** Today's spend has the one confirmation the guards ask for. */
  confirmed: boolean;
  /** What is holding autonomous pickup on money grounds, or null. */
  hold: MeteredHold | null;
  /** True when this is an active overage rather than a metered lane (issue
   * #173) — the same guard, a different sentence. */
  overage: boolean;
}

/** Re-exported from the budgets leaf so the view and the loop can't drift */
export { MAX_ATTEMPTS };

export type NeedsYouCause =
  | "blocked"
  | "signoff"
  /** A run whose review verdict couldn't be read — parked for a human (#90) */
  | "unparseable"
  | "conflict"
  /** A parked PR whose checks stayed red through its repairs (issue #130) */
  | "checks-failing"
  | "exhausted"
  | "cap"
  /** The real-money cap is spent (issue #174) — pickup paused until midnight */
  | "metered-cap"
  /** A metered lane's day is unconfirmed (issue #174) — one press starts it */
  | "metered-confirm"
  | "preflight"
  /** Fleet-health watchdog (issue #126): an owed review that never started, a
   * wedged pickup, a queue poll loop gone quiet. */
  | "review-stalled"
  | "pickup-wedged"
  | "queue-stale"
  /** An answer the owner gave that never reached the agent (issue #136) */
  | "answer-undelivered";

export interface NeedsYouItem {
  cause: NeedsYouCause;
  /** Severity stripe: amber = waiting on you, red = cap breached / exhausted */
  severity: "amber" | "red";
  /** Mono context line, e.g. "lemons #34 · attempt 2/3" */
  context: string;
  /** One-line body */
  body: string;
  /** Read-and-route v1: exactly one link out, or none */
  action: { label: string; href: string } | null;
}

/**
 * A fleet-wide hold on new autonomous pickup (issues #118, #148). Three things
 * hold it, and no two are lifted the same way: the boot master
 * (`AUTONOMY_ENABLED`) takes a config change and a restart, the kill switch is
 * a press on /settings, and the daily cap lifts itself at local midnight. So
 * each carries its own reason and its own copy — telling an owner to lift a
 * switch that would change nothing is the failure this field exists to remove.
 *
 * Per-project holds are deliberately NOT here (issue #148): a fleet of six
 * armed projects, one of them failing preflight, is not a held fleet, and
 * saying so here would over-claim. Those ride {@link ProjectPickupHold}, said
 * beside the project they belong to.
 *
 * Deliberately its own union rather than the reducer's `PauseReason` (which also
 * covers per-project and no-slots holds, neither of them fleet-wide) — the same
 * decoupling this file states for SessionSkill: the read model answers to what
 * the dashboard renders, not to another module's enum.
 */
export interface PickupPause {
  reason:
    | "autonomy-off-at-boot"
    | "kill-switch"
    | "daily-cap"
    /** The real-money cap on a metered lane (issue #174). Its own reason
     * rather than the daily cap's — though the reducer pauses through that
     * one, being one mechanism — because the two say different things to a
     * reader: a plan pushed hard, versus a card charged. */
    | "metered-cap"
    /** A metered lane whose day nobody has confirmed (issue #174). The only
     * hold here lifted by a press *on this screen*. */
    | "metered-unconfirmed"
    | "quota-gate";
  /** One-line banner copy */
  body: string;
}

/**
 * Why one project can't have its tickets claimed right now (issue #148), for
 * the surfaces that already list projects. The reducer fails closed on
 * preflight — a repo whose preflight has never run is as ineligible as one
 * that failed — so "never checked" is its own hold rather than a silent pass.
 *
 * The project's own autonomy toggle is here for the same reason preflight is:
 * a backlog depth printed with nothing beside it reads as work about to
 * start. A hold this union omitted would be exactly the blindness the ticket
 * closes, so it states every reason `decideNext` refuses a project for.
 */
export type ProjectPickupHold =
  | "autonomy-off"
  | "preflight-failing"
  | "preflight-unchecked";

export type PhaseState = "done" | "current" | "todo";

export interface RunningCard {
  /** The run's current task — the in-app chat/stream to open */
  taskId: string | null;
  runId: string | null;
  projectName: string;
  ticket: string | null;
  title: string;
  /** Card kind: afk = full autonomy, supervised = forced human-signoff,
   * interactive = a chat session, triage = a read-only triage pass (#90) */
  mode: "afk" | "supervised" | "interactive" | "triage";
  /** Non-null on a generation session (issue #61): the dashboard and digest
   * label it "session · <skill>" to distinguish it from a plain chat task.
   * Always null for afk/supervised/triage cards. */
  sessionSkill: SessionSkill | null;
  /** implement ▸ review ▸ merge pipeline; null for standalone interactive
   * sessions and triage passes, which sit outside the ticket pipeline */
  phases: { name: "implement" | "review" | "merge"; state: PhaseState }[] | null;
  attempt: { current: number; max: number } | null;
  turns: number;
  startedAt: string | null;
  /** budgetUsd null = unbudgeted (interactive sessions) */
  spend: { usd: number; budgetUsd: number | null };
  /**
   * Why this run is waiting on a clock rather than working, or null while it
   * is actually running (issue #168).
   *
   * A paused run stays *here*, labelled in place, and deliberately never
   * reaches `needsYou`: nobody has to do anything about a quota window, and
   * that section means "a human decision is required". `resumeAfter` is an ISO
   * string like every other time in this view, so the surfaces count down
   * against their own clock rather than a value frozen at the last push.
   */
  paused: { reason: "rate-limited"; resumeAfter: string } | null;
  /**
   * That this run is working below the tier it was asked for, because a
   * tier-scoped allowance ran out and the ladder stepped it down (issue #170);
   * null while it is on the tier it was given.
   *
   * On the card *because* nothing is wrong: a degraded run is working, not
   * waiting, so it never reaches `needsYou` any more than a paused one does —
   * but its output was produced by a cheaper model than the one asked for, and
   * an operator reading the result deserves to know that without opening the
   * ledger.
   */
  degraded: { from: string; to: string } | null;
}

export interface RecentItem {
  title: string;
  projectName: string;
  costUsd: number;
  finishedAt: string;
  prNumber: number | null;
  prUrl: string | null;
  outcome: "merged" | "completed" | "failed" | "exhausted";
}

/**
 * Whether per-ticket tier routing is actually running (issue #198): of the
 * tickets claimed in the window, how many carried a declared tier.
 *
 * Counted per **claim**, not per distinct ticket: the directive is read at
 * each claim, and a ticket edited between attempts can declare a tier on one
 * and not the other — so the fact belongs to the run, and the figure shares
 * its denominator with the outcome rows beside it.
 */
export interface TierCoverage {
  /** Attempts claimed in the window — the ledger's `(ticket, attempt)` pair,
   * so a restart's re-claim (issue #24) is the attempt it continues, not a
   * second claim. */
  claimed: number;
  /** Of those, attempts whose ticket declared a tier in its Workflow section. */
  declared: number;
  /** The rest — attempts that ran on the fleet's default. Said outright rather
   * than left as a remainder, because the point of the figure is that any
   * savings claim drawn from the declared tickets alone is drawn from a
   * biased sample. */
  undeclared: number;
  /** `declared / claimed`, rounded to a whole percent; null when nothing was
   * claimed, which is not 0% coverage. */
  percent: number | null;
}

/**
 * What running work at one tier has cost (issue #198): attempts consumed,
 * review verdicts and spend — so that routing work *down* burning extra
 * attempts and a repair, costing more than the tier saved, shows up as a
 * number rather than an argument.
 *
 * One row per run, grouped by the tier the work ran at (`runs.model`). A run
 * whose tier changed mid-attempt is counted once, under the tier it ended on.
 */
export interface TierOutcome {
  /** `heavy` / `standard` / `light`; a pinned raw model id verbatim when the
   * environment names one; null for attempts that recorded no tier — a claim
   * whose implement pass has not started and carried no directive, a run that
   * failed before start, or one predating the ledger. */
  tier: string | null;
  /** Attempts at this tier claimed in the window. */
  attempts: number;
  /** Distinct tickets those attempts were at, so attempts per ticket — the
   * burn rate — can be read off the row. */
  tickets: number;
  /** Attempts that ended `failed` or `exhausted`: the attempts burned. */
  failed: number;
  /** Attempts whose ticket declared *this* tier — how much of the row is
   * routed work, as against the default or the ladder landing here. */
  declared: number;
  /** Attempts that arrived at this tier by stepping down the ladder (issue
   * #170) rather than by being routed here. */
  degraded: number;
  /** The last verdict posted for each attempt, by kind. The remainder have
   * none yet, or never reached review. */
  verdicts: { approve: number; requestChanges: number; escalate: number };
  /** Every dollar those runs spent — implement, review and repair passes
   * alike, because the cost of running work at a tier includes gating it. */
  spendUsd: number;
}

export interface TierView {
  windowDays: number;
  coverage: TierCoverage;
  /** Tiers with at least one attempt in the window: the vocabulary most
   * capable first, pinned ids after it, the no-tier row last. */
  byTier: TierOutcome[];
}

export type SlotSegment =
  | { occupant: "free" }
  | {
      occupant: "autonomous" | "interactive";
      projectName: string;
      taskId: string;
      /** "#34" for ticket-bound work, null for interactive sessions */
      ticket: string | null;
    };

export interface FleetView {
  generatedAt: string;
  slots: {
    total: number;
    used: number;
    saturated: boolean;
    segments: SlotSegment[];
  };
  spend: {
    todayUsd: number;
    capUsd: number;
    capPaused: boolean;
    /** Real money, kept apart from the figure above (issue #174). That one is
     * autonomous spend against a quota-funded plan; this one is cash, summed
     * over every task that ran on a metered lane — interactive work included,
     * because a chat session on a metered lane charges the same card an
     * implement pass does. The two overlap by construction and are not meant
     * to be added. */
    metered: MeteredSpendView;
  };
  /** Why no new autonomous work is being picked up, or null while nothing
   * fleet-wide holds it (issues #118, #148) — the live dot, the banner and the
   * digest all read this one field, so the surfaces cannot disagree about
   * whether the fleet is running. More than one cause can hold at once; they
   * are named in the order of what a reader must act on first (see the
   * precedence at the assignment). The cap's own `spend.capPaused` is
   * untouched — the gauge and the digest's Spend section read that. */
  pickupPaused: PickupPause | null;
  needsYou: NeedsYouItem[];
  running: RunningCard[];
  recent: { windowDays: number; totalUsd: number; items: RecentItem[] };
  /** Tier coverage and outcome by tier over the same window (issue #198),
   * computed here so the dashboard and the digest cannot describe the fleet's
   * routing differently. */
  tiers: TierView;
  queue: {
    readyForAgent: number | null;
    /** Backlog depth per project, deepest first; null = never observed. `hold`
     * (issue #148) is why that project's tickets can't be claimed — null means
     * only that nothing *project-specific* holds them, since a fleet-wide hold
     * is said once in `pickupPaused` rather than repeated per row. */
    byProject:
      | { projectName: string; count: number; hold: ProjectPickupHold | null }[]
      | null;
  };
  /** True when any project has autonomy enabled */
  autonomyOn: boolean;
  /** The primary lane's quota as last observed (issue #167, per-lane since
   * #175), or null when that lane has reported nothing. Pure display: nothing
   * in the fleet acts on it. */
  quota: QuotaGlance | null;
  /** Which lane that quota belongs to, and whether the lane can report one at
   * all (issue #175) — so a null above reads as "this lane is bounded by
   * spend" rather than as "we have not looked yet". */
  quotaLane: QuotaLaneGlance | null;
}

/**
 * The lane the quota tile is speaking about (issue #175).
 *
 * `reportsQuota` is the whole point of carrying it. A metered lane's quota is
 * null forever, and the tile must say something different from what it says on
 * a subscription lane that simply has not run a pass yet — one is "bounded by
 * spend, by design", the other is "not observed yet".
 */
export interface QuotaLaneGlance {
  id: string;
  label: string;
  billing: LaneBilling;
  /** Whether this lane's provider emits rate-limit telemetry at all. */
  reportsQuota: boolean;
}

/**
 * The quota tile's whole content (issue #167) — one observation, said in the
 * dashboard's own terms.
 *
 * Only one limit window appears because the event only carries one, and that
 * is the answer to "which limit is closest to tripping" rather than a
 * simplification of it: the server picks the *representative claim* — the
 * window nearest its ceiling — and the CLI reports that one.
 *
 * Times are ISO strings, formatted against the client's own clock like the
 * running cards' elapsed times, so "observed 4m ago" keeps ticking between SSE
 * pushes instead of freezing at whatever the last push computed.
 */
export interface QuotaGlance {
  /** The status verbatim, as the CLI said it — including a member this build
   * has never heard of, which reads as itself rather than as nothing. */
  status: string;
  /** How to paint it; `unknown` for a status outside this build's vocabulary. */
  severity: QuotaSeverity;
  /** The limit window closest to tripping, humanised, or null when unreported. */
  limitLabel: string | null;
  /** Percent of that window consumed, or null when the event did not report it
   * — which is usual, and is not zero. */
  utilization: number | null;
  /** When the window resets, or null when unreported (a warning often is). */
  resetsAt: string | null;
  observedAt: string;
}

/** The stored observation, in the terms the tile renders. */
function quotaGlance(observation: QuotaObservation | null): QuotaGlance | null {
  if (!observation) return null;
  return {
    status: observation.status,
    severity: quotaSeverity(observation.status),
    limitLabel:
      observation.rateLimitType === null
        ? null
        : describeRateLimitType(observation.rateLimitType),
    utilization: observation.utilization,
    resetsAt: observation.resetsAt?.toISOString() ?? null,
    observedAt: observation.observedAt.toISOString(),
  };
}

/**
 * The primary lane, in the terms the quota tile renders.
 *
 * `reportsQuota` is derived from the billing kind rather than stored, because
 * that *is* the discriminator: the unified-window machinery is an
 * Anthropic-subscription construct (#165's finding 6), so a metered lane —
 * Anthropic's own API included — emits nothing. Confirmed against OpenRouter on
 * 2026-09-02: no `anthropic-ratelimit-*` response headers, and no
 * `rate_limit_event` on a full harness turn.
 */
function quotaLaneGlance(lane: FleetLaneRow | null): QuotaLaneGlance | null {
  if (!lane) return null;
  return {
    id: lane.id,
    label: lane.label,
    billing: lane.billing,
    // Only `subscription`, positively — a billing kind added later reads as
    // "reports nothing", which is the fail-safe direction: it costs a tile its
    // colour, where the reverse would have the fleet waiting on a reading that
    // never comes.
    reportsQuota: lane.billing === "subscription",
  };
}

/** The banner's one line for a closed quota gate. It names both numbers,
 * because "quota" alone leaves the owner to go and find out how close it was —
 * and it says what is *not* held, since the fleet still looking busy while
 * claiming nothing is exactly the confusion the field exists to remove. */
function quotaPauseBody(gate: ReturnType<typeof evaluateQuotaGate>): string {
  const window =
    gate.rateLimitType === null
      ? "the quota window"
      : `the ${describeRateLimitType(gate.rateLimitType)}`;
  const lead =
    gate.reason === "rejected"
      ? `Quota exhausted — the account is being rejected on ${window}`
      : `Quota nearly spent — ${gate.utilization}% of ${window}, past the ` +
        `${gate.thresholdPercent}% pickup threshold`;
  return (
    `${lead}. No new tickets are claimed; work in flight continues and ` +
    "parked runs still resume"
  );
}

/** Start of the local calendar day containing `now` — the daily autonomous
 * spend cap resets at local midnight. */
export function startOfLocalDay(now: Date): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start;
}

/**
 * Why `decideNext` would refuse this project's tickets, or null when nothing
 * project-specific would (issue #148). Preflight fails closed exactly as the
 * reducer does: only `passing` clears, so a preflight that has never run holds
 * pickup just as a failing one does — and says which, because "we never
 * checked" and "we checked and it's broken" ask different things of a reader.
 */
function projectHold(project: FleetProjectRow): ProjectPickupHold | null {
  if (!project.autonomyEnabled) return "autonomy-off";
  switch (project.preflightStatus) {
    case "passing":
      return null;
    case "failing":
      return "preflight-failing";
    case null:
      return "preflight-unchecked";
    default: {
      // Fail closed twice over, as the pause reasons do: the `never` fails the
      // build when preflightStatus grows a state (the `void` only spends the
      // binding), and until someone teaches this function, a state it doesn't
      // know holds pickup rather than quietly clearing it.
      const unhandled: never = project.preflightStatus;
      void unhandled;
      return "preflight-unchecked";
    }
  }
}

/** "owner/repo#34" -> "#34"; null when the ref has no issue number */
function ticketLabel(githubIssue: string | null): string | null {
  const match = githubIssue?.match(/#(\d+)$/);
  return match ? `#${match[1]}` : null;
}

/** "owner/repo#34" -> "https://github.com/owner/repo/issues/34" */
function issueUrl(githubIssue: string): string | null {
  const match = githubIssue.match(/^([^/#]+)\/([^/#]+)#(\d+)$/);
  return match
    ? `https://github.com/${match[1]}/${match[2]}/issues/${match[3]}`
    : null;
}

/** "owner/repo#34" -> "repo #34" — a compact context label for a fleet-health
 * card, which has no run/project row to hand (the signal carries only a ref). */
function repoTicket(issueRef: string): string {
  const match = issueRef.match(/^[^/#]+\/([^/#]+)#(\d+)$/);
  return match ? `${match[1]} #${match[2]}` : issueRef;
}

const RECENT_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** "an automated repair" / "2 automated repairs" — a spent repair bound reads
 * as prose in the card, not as a bare number. */
function repairCount(n: number): string {
  return n === 1 ? "an automated repair" : `${n} automated repairs`;
}

/** How many failing checks a needs-you body names before summarising the rest —
 * one broken build matrix must not push a card off the screen. */
const NAMED_CHECK_LIMIT = 3;

function namedChecks(checks: string[]): string {
  const rest = checks.length - NAMED_CHECK_LIMIT;
  const shown = checks.slice(0, NAMED_CHECK_LIMIT).join(", ");
  return rest > 0 ? `${shown} +${rest} more` : shown;
}

/** A task in one of these statuses is finished — it can hold no slot and
 * renders as no active session, regardless of a stale container_status. */
const TERMINAL_TASK_STATUSES = new Set<FleetTaskRow["status"]>([
  "completed",
  "failed",
  "cancelled",
]);

/** A live task still has a container and hasn't reached a terminal status — a
 * stale container_status on a finished task (issue #46) is not "live". The one
 * predicate behind slot occupancy and every run's card face. */
const isLiveTask = (t: FleetTaskRow): boolean =>
  t.containerStatus !== null && !TERMINAL_TASK_STATUSES.has(t.status);

/** One attempt at one ticket, folded across the run rows a restart split it
 * into: read through the row that carried it on, charged every row's spend. */
interface TierAttempt {
  latest: FleetRunRow;
  spendUsd: number;
}

/**
 * Tier coverage and outcome by tier (issue #198), over the attempts *claimed*
 * in the recent window.
 *
 * The unit is the **attempt** — the ledger's `(ticket, attempt)` pair — never
 * the task, and not quite the run either. A run whose tier changed mid-attempt
 * owns several task rows (a resume off a pause, a rung down the ladder, a lane
 * move), and counting those would count one attempt twice. A restart adds a
 * *run* row instead: an interrupted run is re-claimed as a new row carrying the
 * same attempt number and consuming no attempt (issue #24), so counting rows
 * would read a ticket restarted twice as three attempts burned — the very
 * figure this exists to show, inflated by the platform's own downtime. The
 * rows of one attempt are therefore folded: read through the latest, which is
 * the row that carried the attempt on, with every row's spend, because what
 * the interrupted row spent is still the attempt's cost.
 *
 * Grouped once, under `runs.model` — the tier the work actually ran at, and
 * the tier its spend is read against. A degraded run therefore sits under the
 * tier it stepped *to*; `degraded` says how many of a row's attempts arrived
 * that way rather than by being routed there, and `declared` counts only the
 * attempts whose ticket named *this* tier, so the same run is never read as
 * "declared standard" on the row it fell to. Known limit, by design: a run that
 * did real work at one tier before a wall stepped it down books all of its
 * spend to the lower tier — `degraded` is the flag to read such a row by.
 *
 * Coverage reads `declaredTier`, never `model`: the implement pass writes the
 * resolved tier to `model` so later passes resolve through it, and from that
 * moment a default is indistinguishable from a declaration. An attempt that
 * declared none is counted, and said, rather than left out.
 *
 * Windowed by `claimedAt` — a claim is dated by when it was made — so coverage
 * and the outcome rows share one denominator: the rows' attempts sum to
 * `coverage.claimed`. Deliberately not the ledger's finish-dated window: the
 * two panels answer different questions, and an attempt claimed eight days ago
 * belongs to last week's routing however recently it finished. Bounded above
 * by `now` for the digest's sake, which evaluates the view at the end of a
 * past day and must know nothing after it.
 */
function tierView(runs: FleetRunRow[], windowStart: number, now: number): TierView {
  const claimedRows = runs.filter(
    (r) => r.claimedAt.getTime() >= windowStart && r.claimedAt.getTime() <= now
  );

  // Fold a restart's re-claim into the attempt it continues (issue #24).
  const rowsByAttempt = new Map<string, FleetRunRow[]>();
  for (const run of claimedRows) {
    const key = `${run.githubIssue}#${run.attempt}`;
    const rows = rowsByAttempt.get(key);
    if (rows) rows.push(run);
    else rowsByAttempt.set(key, [run]);
  }
  const attempts: TierAttempt[] = [...rowsByAttempt.values()].map((rows) => ({
    latest: rows.reduce((a, b) =>
      b.claimedAt.getTime() > a.claimedAt.getTime() ? b : a
    ),
    spendUsd: rows.reduce((sum, r) => sum + r.totalCostUsd, 0),
  }));
  const declared = attempts.filter((a) => a.latest.declaredTier !== null).length;

  // A legacy alias (`opus`) names a tier and groups under it; a pinned raw
  // model id names none and is kept verbatim, because "which model" is still
  // the question when the answer is not a tier; an attempt that recorded
  // nothing groups under null and is shown as such rather than dropped.
  const tierOf = (r: FleetRunRow): string | null =>
    r.model === null ? null : (normalizeModelTier(r.model) ?? r.model);

  const groups = new Map<string | null, TierAttempt[]>();
  for (const attempt of attempts) {
    const tier = tierOf(attempt.latest);
    const group = groups.get(tier);
    if (group) group.push(attempt);
    else groups.set(tier, [attempt]);
  }

  // The vocabulary's own order (most to least capable), then any pinned ids
  // by name, then the attempts that recorded no tier.
  const rank = (tier: string | null): number => {
    if (tier === null) return MODEL_TIERS.length + 1;
    const i = (MODEL_TIERS as readonly string[]).indexOf(tier);
    return i === -1 ? MODEL_TIERS.length : i;
  };
  const count = (group: TierAttempt[], test: (r: FleetRunRow) => boolean) =>
    group.filter((a) => test(a.latest)).length;
  const byTier: TierOutcome[] = [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || (a ?? "").localeCompare(b ?? ""))
    .map(([tier, group]) => ({
      tier,
      attempts: group.length,
      tickets: new Set(group.map((a) => a.latest.githubIssue)).size,
      // `exhausted` is the last failed attempt, relabelled when the ticket
      // went to a human — a burned attempt under another name.
      failed: count(group, (r) => r.status === "failed" || r.status === "exhausted"),
      // Only a ticket that named *this* tier: a run that declared heavy and
      // fell to standard is routed work on neither row.
      declared: count(
        group,
        (r) => r.declaredTier !== null && normalizeModelTier(r.declaredTier) === tier
      ),
      degraded: count(group, (r) => r.degradedFrom !== null),
      verdicts: {
        approve: count(group, (r) => r.reviewVerdict === "approve"),
        requestChanges: count(group, (r) => r.reviewVerdict === "request-changes"),
        escalate: count(group, (r) => r.reviewVerdict === "escalate"),
      },
      spendUsd: group.reduce((sum, a) => sum + a.spendUsd, 0),
    }));

  return {
    windowDays: RECENT_WINDOW_DAYS,
    coverage: {
      claimed: attempts.length,
      declared,
      undeclared: attempts.length - declared,
      percent:
        attempts.length === 0 ? null : Math.round((declared / attempts.length) * 100),
    },
    byTier,
  };
}

export function buildFleetView(rows: FleetRows): FleetView {
  const projectById = new Map(rows.projects.map((p) => [p.id, p]));
  const runById = new Map(rows.runs.map((r) => [r.id, r]));
  const projectName = (id: string) => projectById.get(id)?.name ?? id;

  // A slot is a live container running (or setting up) an agent process.
  // Tasks are the container unit for every kind of work, so occupancy — and
  // what saturation is attributable to — reads straight off tasks with a
  // container status. A parked autonomous container (an implement pass
  // idling while its PR is reviewed, issue #17) stays alive but runs no
  // agent and holds no slot; an idle interactive session does hold its slot.
  //
  // A task in a terminal status is never an active session, whatever
  // container_status says: cancellation and completion should null the column,
  // but a stale value (issue #46: a task cancelled months ago still carrying
  // container_status='idle') must not resurrect it as a running session here.
  const occupants = rows.tasks.filter(
    (t) =>
      isLiveTask(t) && !(t.kind !== "interactive" && t.containerStatus === "idle")
  );
  const segments: SlotSegment[] = occupants.map((t) => {
    const run = t.runId ? runById.get(t.runId) : undefined;
    return {
      occupant: t.kind === "interactive" ? ("interactive" as const) : ("autonomous" as const),
      projectName: projectName(t.projectId),
      taskId: t.id,
      ticket: ticketLabel(run?.githubIssue ?? t.githubIssue),
    };
  });
  while (segments.length < rows.slots) segments.push({ occupant: "free" });

  // Today's autonomous spend mirrors todayAutonomousSpendUsd: a sum over
  // runs claimed since local midnight. Interactive tasks have no run, which
  // exempts them by construction rather than by a filter. The upper bound
  // matters only to the digest, which evaluates the view at the end of a
  // past day over live rows — the view must know nothing after `now`.
  const dayStart = startOfLocalDay(rows.now).getTime();
  const todayUsd = rows.runs
    .filter(
      (r) =>
        r.claimedAt.getTime() >= dayStart &&
        r.claimedAt.getTime() <= rows.now.getTime()
    )
    .reduce((sum, r) => sum + r.totalCostUsd, 0);
  const capPaused = todayUsd >= rows.dailyCapUsd;

  // Real money (issue #174), taken from the per-day ledger rather than derived
  // here. Nothing is exempt by kind — a chat session on a metered lane charges
  // the same card an implement pass does — which is exactly how it differs
  // from the figure above, where interactive work is exempt by construction.
  // The two overlap and must never be added.
  const meteredTodayUsd = rows.meteredSpendTodayUsd;
  // The same pure evaluation the reducer runs, over the same facts: the tile
  // and the sweep cannot disagree about whether money is holding the fleet.
  const meteredState = evaluateMeteredSpend({
    billing: rows.primaryLaneBilling,
    spentUsd: meteredTodayUsd,
    capUsd: rows.meteredCapUsd,
    confirmedAt: rows.meteredSpendConfirmedAt,
    now: rows.now,
  });
  const metered: MeteredSpendView = {
    active: meteredState.metered,
    laneId: rows.primaryLaneId,
    todayUsd: meteredTodayUsd,
    capUsd: rows.meteredCapUsd,
    capPaused: meteredState.hold === "cap-reached",
    confirmed: meteredState.confirmed,
    hold: meteredState.hold,
    overage: rows.primaryLaneOverage,
  };

  // Who the money is actually going to, for the sentences below: an active
  // overage bills the card while the lane in force still declares itself a
  // subscription (issue #173), so naming the lane alone would read as an
  // accusation against a lane that bills nothing.
  const payer = metered.overage
    ? `an active overage on ${metered.laneId ?? "the subscription"}`
    : metered.laneId;

  // The same gate `decideNext` refuses pickup with (issue #171), from the same
  // pure function: the banner is not allowed to have its own opinion about
  // whether work is being claimed. Ranked below the cap for the reason the cap
  // is ranked below the switch — of the two self-lifting holds, the cap is the
  // one whose ceiling a human chose, and the Quota tile keeps saying its own
  // piece whichever wins.
  const quotaGate = evaluateQuotaGate(
    rows.quota,
    rows.quotaThresholdPercent,
    rows.now
  );

  // What the live dot, the banner and the digest all say (issues #118, #148).
  // Precedence is by what a reader must act on, and it is why the boot master
  // leads: with `AUTONOMY_ENABLED` off no sweep runs at all, so naming the kill
  // switch there would send an owner to press a control that changes nothing.
  // Below it the switch outranks the cap — both can hold, but the switch is the
  // one a human engaged and the one they can lift, while midnight lifts the cap
  // on its own. The two money holds (issue #174) sit under the cap, in the
  // order the reducer refuses them: a spent cash cap, then a day nobody has
  // confirmed. Whichever wins, the others keep their own surfaces: the cap's
  // gauge and needs-you card are untouched by being outranked here.
  const pickupPaused: PickupPause | null = !rows.autonomyEnabledAtBoot
    ? {
        reason: "autonomy-off-at-boot",
        body: "Autonomy is off on this install (AUTONOMY_ENABLED) — no sweep runs at all, so nothing is claimed; the kill switch cannot start one",
      }
    : rows.globalAutonomyPaused
      ? {
          reason: "kill-switch",
          body: "Kill switch engaged — no new autonomous pickup; runs already in flight continue",
        }
      : capPaused
        ? {
            reason: "daily-cap",
            body: "Daily cap reached — autonomous pickup paused until midnight",
          }
        : metered.hold === "cap-reached"
          ? {
              reason: "metered-cap",
              body: `Real-money cap reached on ${payer ?? "a metered lane"} — autonomous pickup paused until midnight; interactive work is capped too`,
            }
          : metered.hold === "unconfirmed"
            ? {
                reason: "metered-unconfirmed",
                body: `${payer ?? "The primary lane"} is spending real money — pickup is held until today's spend is confirmed once`,
              }
            : quotaGate.closed
              ? {
                  reason: "quota-gate",
                  body: quotaPauseBody(quotaGate),
                }
              : null;

  const tasksOfRun = (runId: string) =>
    rows.tasks.filter((t) => t.runId === runId);

  // Newest pass first, with a stable id tiebreak so a createdAt collision
  // between two passes can't resolve arbitrarily (ULIDs sort by creation time).
  const byNewest = (a: FleetTaskRow, b: FleetTaskRow) =>
    b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id);

  // A pass whose container is actually executing: live (issue #46's terminal
  // guard) and not parked idle. The one predicate behind both pickPass's busy
  // preference and the gated-run activity gate (hasBusyPass).
  const isBusyPass = (t: FleetTaskRow): boolean =>
    isLiveTask(t) && t.containerStatus !== "idle";

  // The pass kinds that make up a run's current phase: a reviewing or gated run
  // is on its review pass; every other status is on its implement/repair pass.
  // This mirrors the orchestrator's own workingTaskOf, which selects the working
  // pass by kind — the view must resolve a run's face by phase, not by inferring
  // it from container_status races (issue #96).
  const phaseKinds = (status: FleetRunRow["status"]): FleetTaskRow["kind"][] =>
    status === "reviewing" || status === "gated"
      ? ["review"]
      : ["implement", "repair"];

  // Pick a run's face from the passes of its current phase: prefer the container
  // actually executing, else the newest. When the review pass has finished but
  // the run is still reviewing (its container gone, or idle between turns), no
  // pass is busy, so the newest — deliberately including that finished review
  // pass — is returned. That is the point: the card stays on the review pass
  // rather than the parked implement beside it (issue #96, symptom 1).
  const pickPass = (pool: FleetTaskRow[]): FleetTaskRow | null => {
    const busy = pool.filter(isBusyPass);
    return (busy.length > 0 ? busy : pool).sort(byNewest)[0] ?? null;
  };

  // A run's live face — the task its card shows and links to — resolved within
  // the run's current phase only. If that phase owns no pass yet (a brief window
  // after the status flips to reviewing, before the review pass is queued), the
  // card links nowhere rather than falling back to the wrong-phase implement
  // pass: a non-clickable review card, not a link to the finished implement task
  // (issue #96). It also resolves duplicate review passes (issue #95) to the one
  // really running.
  const currentPassOf = (run: FleetRunRow): FleetTaskRow | null =>
    pickPass(
      tasksOfRun(run.id).filter((t) => phaseKinds(run.status).includes(t.kind))
    );

  // Whether a run has a container actually executing right now — a live,
  // non-idle pass on a slot. A gated run reads as fleet activity only while this
  // holds; without it the run is between sweeps or already resolved (issue #90).
  const hasBusyPass = (runId: string): boolean =>
    tasksOfRun(runId).some(isBusyPass);

  const runContext = (run: FleetRunRow) =>
    `${projectName(run.projectId)} ${ticketLabel(run.githubIssue) ?? run.githubIssue} · attempt ${run.attempt}/${MAX_ATTEMPTS}`;

  // Decision locked in review: actions are read-and-route in v1. A blocked
  // question deep-links to the Discord channel where a reply becomes the next
  // turn; without a Discord route it falls back to the in-app task chat.
  const blockedAction = (run: FleetRunRow): NeedsYouItem["action"] => {
    const channelId = projectById.get(run.projectId)?.discordChannelId;
    if (rows.discordGuildId && channelId) {
      return {
        label: "Answer in Discord",
        href: `https://discord.com/channels/${rows.discordGuildId}/${channelId}`,
      };
    }
    const task = currentPassOf(run);
    return task ? { label: "Open task", href: `/tasks/${task.id}` } : null;
  };

  // Where a gated run's review stands — the single source of truth for both
  // its needs-you disposition and whether it still reads as fleet activity
  // (issue #90), so the two can never disagree. A gated run is exactly one of
  // these. Precedence: a spent-repairs conflict (issue #54) outranks a stored
  // verdict, an unreadable verdict outranks a posted one, and only a posted
  // approve/escalate is a sign-off wait; anything else means the review is
  // still in flight.
  type GatedDisposition =
    | { kind: "conflict" }
    | { kind: "checks-failing"; checks: string[] }
    | { kind: "unparseable" }
    | { kind: "signoff"; verdict: "approve" | "escalate" }
    | { kind: "in-flight" };
  const classifyGated = (run: FleetRunRow): GatedDisposition => {
    if (run.integrationCount >= MAX_INTEGRATION_ATTEMPTS) return { kind: "conflict" };
    // Red checks (issue #130) take both facts: the repairs are spent AND the
    // sweep still sees the rollup red. The counter alone would raise a card in
    // the window after a repair pushes, while the new head's checks are pending.
    const failingChecks = rows.failingChecksByRun?.[run.id];
    if (run.ciRepairCount >= MAX_CI_REPAIR_ATTEMPTS && failingChecks?.length) {
      return { kind: "checks-failing", checks: failingChecks };
    }
    if (run.reviewResult?.kind === "unparseable") return { kind: "unparseable" };
    if (run.reviewVerdict === "approve" || run.reviewVerdict === "escalate") {
      return { kind: "signoff", verdict: run.reviewVerdict };
    }
    return { kind: "in-flight" };
  };

  // Ordered by what to do next: the fleet-wide pause first, then a parked
  // agent waiting on an answer, then reviews, then post-mortems, then config.
  const needsYou: NeedsYouItem[] = [];

  if (capPaused) {
    needsYou.push({
      cause: "cap",
      severity: "red",
      context: `$${todayUsd.toFixed(2)} / $${rows.dailyCapUsd.toFixed(2)} today`,
      body: "Autonomous pickup paused until midnight — interactive work unaffected",
      action: null,
    });
  }

  // The money guards (issue #174). Beside the cap card and shaped like it,
  // because they hold the fleet the same way — but each carries the remedy
  // that actually applies: the cash cap wants the cap raised (or the day
  // ended), and the confirmation wants one press.
  if (metered.hold === "cap-reached") {
    needsYou.push({
      cause: "metered-cap",
      severity: "red",
      context: `$${metered.todayUsd.toFixed(2)} / $${metered.capUsd.toFixed(2)} real money today`,
      body: `Real-money cap spent on ${payer ?? "a metered lane"} — autonomous pickup paused until midnight, and an interactive session is told it is capped rather than spending past it. Raise the cap to carry on today.`,
      action: { label: "Settings", href: "/settings" },
    });
  } else if (metered.hold === "unconfirmed") {
    needsYou.push({
      cause: "metered-confirm",
      severity: "amber",
      context: `${payer ?? "primary lane"} · cap $${metered.capUsd.toFixed(2)}`,
      body: "Real money is being spent and today's spend isn't confirmed — autonomous pickup is held, and an interactive session asks for the same press, until you confirm it once.",
      action: { label: "Settings", href: "/settings" },
    });
  }

  // Fleet-health watchdog (issue #126): the machinery itself has stalled, so
  // these outrank any single run's question or sign-off. A dead queue or a
  // wedged pickup halts the whole frontier (the parent #115 incident hid one for
  // ~1.5h behind a dashboard that read healthy); an owed review that never
  // started strands a specific PR. All red — nothing progresses until you look.
  const health = rows.fleetHealth;
  if (health?.queueStale) {
    needsYou.push({
      cause: "queue-stale",
      severity: "red",
      context: "queue loop",
      body: `Queue poll loop hasn't made progress for ${formatDuration(
        health.queueStale.staleForMs
      )} — dispatch is likely wedged`,
      action: null,
    });
  }
  if (health?.pickupWedged) {
    needsYou.push({
      cause: "pickup-wedged",
      severity: "red",
      context: "pickup",
      // The remedy is part of the card, not a thing to know: a phantom slot
      // (#152) is cleared only by a restart, an ordinary wedge is something to
      // go and look at, and the two are indistinguishable from the symptom.
      body: `${health.pickupWedged.detail} for ${formatDuration(
        health.pickupWedged.wedgedForMs
      )}. ${health.pickupWedged.remedy}`,
      action: null,
    });
  }
  // An answer the owner has already given that the agent never received
  // (issue #136). Red, and above the run-level cards: the owner has done their
  // part, so this is the machinery failing to carry it.
  //
  // The remedy names memory rather than a restart. Boot adoption (#136) and the
  // external agent network (#190) between them removed the two reasons a
  // restart used to be the answer, and the evaluator only raises this for an
  // *idle* session — so what is left is a resume the memory-admission gate keeps
  // deferring, which a restart would not help.
  for (const answer of health?.undeliveredAnswers ?? []) {
    needsYou.push({
      cause: "answer-undelivered",
      severity: "red",
      context: answer.label,
      body:
        `Your answer has sat undelivered for ${formatDuration(
          answer.undeliveredForMs
        )} — the session is idle and has not taken it. ` +
        "A parked container is only resumed when the box has memory headroom; check free memory.",
      action: { label: "Open session", href: answer.taskUrl },
    });
  }

  for (const stall of health?.owedReviewStalls ?? []) {
    const prTag = `PR #${stall.prNumber}`;
    needsYou.push({
      cause: "review-stalled",
      severity: "red",
      context: `${repoTicket(stall.issueRef)} · ${prTag}`,
      body: `Review hasn't started for ${formatDuration(
        stall.stalledForMs
      )} — ${stall.reason}`,
      action: stall.prUrl ? { label: `Open ${prTag}`, href: stall.prUrl } : null,
    });
  }

  for (const run of rows.runs.filter((r) => r.status === "blocked")) {
    needsYou.push({
      cause: "blocked",
      severity: "amber",
      context: runContext(run),
      body: run.blockedQuestion ?? "Agent asked a question",
      action: blockedAction(run),
    });
  }

  // A gated run's needs-you disposition follows where its review stands
  // (issue #90). Repairs spent → a red merge-conflict stall (issue #54); an
  // unreadable verdict → a run parked for a human, its own distinct cause; a
  // posted approve/escalate → a genuine sign-off wait, the PR one human step
  // away. A gated run whose review is still in flight is fleet activity, not a
  // needs-you item — it appears under Running until a verdict lands, so the
  // sign-off bucket never fires prematurely on a still-reviewing PR.
  for (const run of rows.runs.filter((r) => r.status === "gated")) {
    // "PR #55" when the number is known, a bare "PR" otherwise — the copy and
    // the action label share it, so neither has to re-branch on the number.
    const prTag = run.pullRequestNumber ? `PR #${run.pullRequestNumber}` : "PR";
    const link = (label: string): NeedsYouItem["action"] =>
      run.pullRequestUrl ? { label, href: run.pullRequestUrl } : null;
    const disposition = classifyGated(run);

    if (disposition.kind === "conflict") {
      needsYou.push({
        cause: "conflict",
        severity: "red",
        context: runContext(run),
        body: `${prTag} still conflicts with the default branch — resolve and merge`,
        action: link(`Resolve ${prTag}`),
      });
    } else if (disposition.kind === "checks-failing") {
      needsYou.push({
        cause: "checks-failing",
        severity: "red",
        context: runContext(run),
        body:
          `${prTag} checks still failing after ${repairCount(run.ciRepairCount)}: ` +
          namedChecks(disposition.checks),
        action: link(`Open ${prTag}`),
      });
    } else if (disposition.kind === "unparseable") {
      needsYou.push({
        cause: "unparseable",
        severity: "red",
        context: runContext(run),
        body: `Review verdict couldn't be read on ${prTag} — parked, nothing merges until you look`,
        action: link(`Open ${prTag}`),
      });
    } else if (disposition.kind === "signoff") {
      needsYou.push({
        cause: "signoff",
        severity: "amber",
        context: runContext(run),
        body:
          disposition.verdict === "escalate"
            ? `${prTag} — the reviewer escalated for your sign-off`
            : `${prTag} waits for your sign-off`,
        action: link(`Review ${prTag}`),
      });
    }
    // disposition.kind === "in-flight": review still running — fleet activity,
    // surfaced under Running, deliberately not a needs-you item.
  }

  // An exhausted ticket needs a human until they re-arm it (a newer run
  // exists for the issue), until the tracker shows they've dealt with it, or
  // — the backstop — until it ages out of the recent window. The DB can't see
  // the tracker on its own, so the sweep records which issues are still open
  // and `ready-for-human` (needsHumanByProject); an exhausted run whose
  // project was observed but whose issue has left that set was resolved
  // outside a fresh loop (a human merged the fix or dropped the label) and no
  // longer names an outstanding action. Only the window applies to a project
  // the sweep hasn't observed — clearing on absence there would be guessing.
  const windowStart = rows.now.getTime() - RECENT_WINDOW_DAYS * DAY_MS;
  const resolvedOnTracker = (r: FleetRunRow): boolean => {
    const observed = rows.needsHumanByProject?.[r.projectId];
    return observed !== undefined && !observed.includes(r.githubIssue);
  };
  const exhausted = rows.runs.filter(
    (r) =>
      r.status === "exhausted" &&
      (r.finishedAt?.getTime() ?? 0) >= windowStart &&
      !resolvedOnTracker(r) &&
      !rows.runs.some(
        (newer) =>
          newer.githubIssue === r.githubIssue &&
          newer.claimedAt.getTime() > r.claimedAt.getTime()
      )
  );
  for (const run of exhausted) {
    const href = issueUrl(run.githubIssue);
    needsYou.push({
      cause: "exhausted",
      severity: "red",
      context: runContext(run),
      body: "Attempts exhausted — ticket is ready-for-human",
      action: href
        ? { label: `Open issue ${ticketLabel(run.githubIssue)}`, href }
        : null,
    });
  }

  // Running = active fleet work. Every run mid-pipeline shows its
  // implement ▸ review ▸ merge phases; a gated run whose review is still in
  // flight (issue #90) is activity too, not a premature sign-off, so it appears
  // here until a verdict lands and moves it to needs-you. Interactive sessions
  // and triage passes are quiet standalone cards holding slots outside the
  // ticket pipeline.
  const ACTIVE_RUN_STATUSES = new Set<FleetRunRow["status"]>([
    "claimed",
    "implementing",
    "reviewing",
    "blocked",
    // A quota-paused run (issue #168) is still the fleet's work in progress —
    // it holds its ticket and its branch, and only a clock stands between it
    // and its next turn — so it belongs here, shown paused, rather than
    // vanishing from the dashboard between the wall and the reset. It holds no
    // slot: the pause tore its container down, so `slots.used` is untouched.
    "rate_limited",
  ]);
  // The review stage is live for both the armed path (status `reviewing`) and a
  // gated run whose review is still in flight (the only gated runs that reach
  // Running — a landed verdict routes them to needs-you instead).
  const phasePipeline = (
    reviewing: boolean
  ): NonNullable<RunningCard["phases"]> => [
    { name: "implement", state: reviewing ? "done" : "current" },
    { name: "review", state: reviewing ? "current" : "todo" },
    { name: "merge", state: "todo" },
  ];

  const running: RunningCard[] = rows.runs
    .filter(
      (r) =>
        ACTIVE_RUN_STATUSES.has(r.status) ||
        // A gated run reads as activity only while its review is genuinely in
        // flight — a live pass on a slot. Without one it is either between
        // sweeps or already resolved, not something to show as running.
        (r.status === "gated" &&
          classifyGated(r).kind === "in-flight" &&
          hasBusyPass(r.id))
    )
    .sort((a, b) => a.claimedAt.getTime() - b.claimedAt.getTime())
    .map((run) => {
      const pass = currentPassOf(run);
      // A `rate_limited` run paused during an implement-shaped pass — the only
      // kind #168 pauses, not the only kind a wall can refuse: a walled review
      // pass still fails closed to a human, and #171 is the ticket that stops a
      // pass starting under a wall at all. So it reads with implement current,
      // which is where it resumes from.
      const reviewing = run.status === "reviewing" || run.status === "gated";
      // An in-flight review pass reads with its own spend against the review
      // budget (issue #90); the run's rolled-up spend against the attempt
      // budget would read as the implement pass and hide the review's cost.
      const spend =
        pass?.kind === "review"
          ? { usd: pass.totalCostUsd, budgetUsd: DEFAULT_REVIEW_BUDGET_USD }
          : { usd: run.totalCostUsd, budgetUsd: run.budgetUsd };
      return {
        taskId: pass?.id ?? null,
        runId: run.id,
        projectName: projectName(run.projectId),
        ticket: ticketLabel(run.githubIssue),
        title: pass?.title ?? run.githubIssue,
        mode: run.mode === "autonomous" ? ("afk" as const) : ("supervised" as const),
        sessionSkill: null,
        phases: phasePipeline(reviewing),
        attempt: { current: run.attempt, max: MAX_ATTEMPTS },
        turns: pass?.turns ?? 0,
        startedAt: (run.startedAt ?? run.claimedAt).toISOString(),
        spend,
        // Only a run the ledger calls paused reads as paused, and only with the
        // clock it is actually waiting on: a `rate_limited` row that somehow
        // carries no resumeAfter would be a run waiting on nothing, which is a
        // claim this view refuses to make on a screen an operator trusts.
        //
        // The instant shown is the run's *eligible* one — the window's reset
        // plus this run's own jitter (issue #169) — through the same function
        // the reducer decides with. A countdown that hit zero minutes before
        // anything moved would be the screen and the fleet disagreeing about
        // the one number the card exists to show.
        paused:
          run.status === "rate_limited" && run.resumeAfter
            ? {
                reason: "rate-limited" as const,
                resumeAfter: resumeEligibleAt(
                  run.id,
                  run.resumeAfter,
                  RESUME_JITTER_WINDOW_MS
                ).toISOString(),
              }
            : null,
        // Both tiers or neither: `degradedFrom` is only ever written beside the
        // tier stepped to, so a row carrying one without the other could not
        // say what it stepped between — and half a claim on this screen is
        // worse than none (issue #170).
        degraded:
          run.degradedFrom !== null && run.model !== null
            ? { from: run.degradedFrom, to: run.model }
            : null,
      };
    });

  // Standalone passes with no ticket pipeline: interactive chat sessions and
  // read-only triage passes (issue #90). Triage reads as its own kind of work
  // with the triage pass's spend against the triage budget; both take their
  // face straight from the occupying task.
  for (const task of occupants.filter(
    (t) => t.kind === "interactive" || t.kind === "triage"
  )) {
    const triage = task.kind === "triage";
    running.push({
      taskId: task.id,
      runId: null,
      projectName: projectName(task.projectId),
      // A generation session shows the issue it's anchored to (issue #61); the
      // anchor lives in sessionIssue, never githubIssue, on an interactive task.
      ticket: ticketLabel(task.githubIssue ?? task.sessionIssue),
      title: task.title,
      mode: triage ? "triage" : "interactive",
      // Only an interactive session carries a skill; the autonomous triage pass
      // (kind=triage) is never a generation session.
      sessionSkill: triage ? null : task.sessionSkill,
      phases: null,
      attempt: null,
      turns: task.turns,
      startedAt: task.createdAt.toISOString(),
      spend: {
        usd: task.totalCostUsd,
        budgetUsd: triage ? DEFAULT_TRIAGE_BUDGET_USD : null,
      },
      // A standalone session or triage pass has no run to pause or degrade:
      // both are run-ledger states (issues #168, #170).
      paused: null,
      degraded: null,
    });
  }

  // Preflight only matters where autonomy is asked for — a dormant project
  // failing preflight needs nothing from anyone. Read through the same
  // projectHold the backlog rows use, so a card and a backlog line can never
  // disagree about whether a project is pickable; and each card says the
  // consequence, not just the state, because "preflight failing" alone leaves
  // the reader to infer that nothing is being claimed there (issue #148).
  for (const project of rows.projects) {
    if (!project.autonomyEnabled) continue;
    const hold = projectHold(project);
    if (hold === null) continue;
    needsYou.push({
      cause: "preflight",
      severity: "amber",
      context: project.name,
      body:
        hold === "preflight-failing"
          ? `Preflight failing, so none of its tickets are picked up: ${project.preflightReason ?? "reason unknown"}`
          : "Preflight has never run, so none of its tickets are picked up — pickup fails closed until it passes.",
      action: { label: "Open settings", href: "/settings" },
    });
  }

  // The quiet 7-day ledger: terminal runs plus completed interactive
  // sessions. Run-owned tasks are represented by their run, never listed
  // twice; cancelled work was a deliberate human act, not a completion.
  const RUN_OUTCOMES: Partial<Record<FleetRunRow["status"], RecentItem["outcome"]>> = {
    merged: "merged",
    failed: "failed",
    exhausted: "exhausted",
  };
  const recentItems: RecentItem[] = [];
  for (const run of rows.runs) {
    const outcome = RUN_OUTCOMES[run.status];
    const finishedAt = run.finishedAt;
    if (!outcome || !finishedAt || finishedAt.getTime() < windowStart) continue;
    const task = currentPassOf(run);
    recentItems.push({
      title: task?.title ?? run.githubIssue,
      projectName: projectName(run.projectId),
      costUsd: run.totalCostUsd,
      finishedAt: finishedAt.toISOString(),
      prNumber: run.pullRequestNumber,
      prUrl: run.pullRequestUrl,
      outcome,
    });
  }
  for (const task of rows.tasks) {
    if (task.runId !== null) continue;
    if (task.status !== "completed" && task.status !== "failed") continue;
    if (task.updatedAt.getTime() < windowStart) continue;
    recentItems.push({
      title: task.title,
      projectName: projectName(task.projectId),
      costUsd: task.totalCostUsd,
      finishedAt: task.updatedAt.toISOString(),
      prNumber: task.pullRequestNumber,
      prUrl: task.pullRequestUrl,
      outcome: task.status === "completed" ? "completed" : "failed",
    });
  }
  recentItems.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
  const recentTotalUsd = recentItems.reduce((sum, i) => sum + i.costUsd, 0);

  // Backlog entries answer to the projects table — an observation for a
  // since-deleted project counts nowhere.
  const backlog = rows.backlogByProject
    ? Object.entries(rows.backlogByProject)
        .flatMap(([projectId, count]) => {
          const project = projectById.get(projectId);
          return project
            ? [{ projectName: project.name, count, hold: projectHold(project) }]
            : [];
        })
        .sort(
          (a, b) =>
            b.count - a.count || a.projectName.localeCompare(b.projectName)
        )
    : null;

  return {
    generatedAt: rows.now.toISOString(),
    slots: {
      total: rows.slots,
      used: occupants.length,
      saturated: occupants.length >= rows.slots,
      segments,
    },
    spend: { todayUsd, capUsd: rows.dailyCapUsd, capPaused, metered },
    pickupPaused,
    needsYou,
    running,
    recent: {
      windowDays: RECENT_WINDOW_DAYS,
      totalUsd: recentTotalUsd,
      items: recentItems,
    },
    tiers: tierView(rows.runs, windowStart, rows.now.getTime()),
    queue: {
      readyForAgent: backlog
        ? backlog.reduce((sum, b) => sum + b.count, 0)
        : null,
      byProject: backlog,
    },
    autonomyOn: rows.projects.some((p) => p.autonomyEnabled),
    quota: quotaGlance(rows.quota),
    quotaLane: quotaLaneGlance(rows.quotaLane),
  };
}
