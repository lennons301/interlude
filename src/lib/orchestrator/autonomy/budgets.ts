/**
 * Budget constants for autonomous passes. A leaf module — both the sweep
 * (claim time) and the turn manager (exec time) need these, and importing
 * either into the other would create a cycle. The ticket-directive parser
 * (issue #18) clamps against the ceilings defined here.
 */

/** Default per-attempt budget for an autonomous implement pass. */
export const DEFAULT_ATTEMPT_BUDGET_USD = 20;

/** Hard ceiling a ticket's `budget:` directive may raise an attempt to.
 * Issue text is semi-trusted input; nothing it says can exceed this. */
export const MAX_ATTEMPT_BUDGET_USD = 75;

/** Hard ceiling a ticket's `max-turns:` directive may raise a pass's
 * per-exec turn limit to (the default is the orchestrator's MAX_TURNS). */
export const MAX_TURNS_CEILING = 100;

/* The tiers a ticket's `model:` directive may select live in
 * `src/lib/model-tiers.ts` (issue #166), not here: the same vocabulary is what
 * the settings UI offers and what the environment defaults are read against,
 * and a body is semi-trusted input that may only choose from it — never name
 * an arbitrary model string — mirroring the reasoning behind the $75 budget
 * clamp. Clamped in the directive parser, resolved through
 * `resolveAgentModelChoice`. */

/** Reasoning-effort levels a ticket's `effort:` directive may select (issue
 * #81), the exact set the headless CLI's `--effort` flag accepts. A ticket
 * body is semi-trusted input, so it may only choose from this fixed set —
 * never name an arbitrary value — mirroring the reasoning behind the budget
 * clamp. The level reaches the CLI as `--effort`; an unrecognised value is
 * ignored (the run keeps its default effort), never fatal. Clamped in the
 * directive parser, resolved through `resolveAgentEffort`. */
export const ALLOWED_TICKET_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** Budget for one review pass — its own allowance, separate from the
 * implement attempt's, so reviewing never eats into a fix-up's headroom. */
export const DEFAULT_REVIEW_BUDGET_USD = 5;

/** Budget for one triage pass — shaping the backlog must cost a fraction of
 * implementing a ticket. */
export const DEFAULT_TRIAGE_BUDGET_USD = 2;

/** Budget for one repair pass (issue #54): merging the default branch into a
 * conflicting PR branch is a small mechanical turn, so it carries its own
 * modest allowance rather than the implement attempt's full budget. */
export const DEFAULT_REPAIR_BUDGET_USD = 5;

/** Repair passes run to integrate a CONFLICTING parked PR before it escalates
 * to a human (issue #54). One automated merge of the default branch either
 * clears the conflict or it is a genuine content clash needing human
 * judgement, which a second identical attempt would not resolve — so the
 * bound is one. Counted per conflict episode (reset once the PR is mergeable
 * again) and, unlike an attempt, never charged against MAX_ATTEMPTS. */
export const MAX_INTEGRATION_ATTEMPTS = 1;

/** CI-repair passes run to make a red check rollup green before a parked PR
 * escalates to a human (issue #130). Bounded at one for the same reason as
 * MAX_INTEGRATION_ATTEMPTS: one pass either fixes the failing checks or the
 * failure needs human judgement, which an identical second pass would not
 * supply. Counted per episode on runs.ciRepairCount (reset once the rollup is
 * observed green) and, unlike an attempt, never charged against MAX_ATTEMPTS.
 * Deliberately its own counter rather than integrationCount's: a conflict
 * repair followed by an unrelated CI failure must not escalate on a spent count. */
export const MAX_CI_REPAIR_ATTEMPTS = 1;

/** Consecutive sweeps a rollup must be observed failing before a CI repair is
 * spent (issue #130). The motivating failure sat beside an infrastructure-shaped
 * one, and the ticket gets exactly one repair — so one sweep (30s) of latency
 * buys confirmation that the red is real. See checks.ts for the fold. */
export const CHECK_FAILURE_CONFIRMATION_SWEEPS = 2;

/** Per-exec turn cap for a triage pass: read the issue against the repo's
 * context, judge, exit. Not raisable — triage reads semi-trusted input and
 * has no directive surface. */
export const TRIAGE_MAX_TURNS = 15;

/** Triage passes allowed per issue, ever: the first, plus one retry after a
 * failure (an unparseable exit whose announcement landed, or a pass that
 * died before storing one). Beyond that the issue sits visibly labelled
 * needs-triage for a human to route — never an unbounded spend loop. */
export const MAX_TRIAGE_PASSES_PER_ISSUE = 2;

/** Attempts per ticket before it is routed back to a human
 * (`ready-for-agent` swapped for `ready-for-human`). */
export const MAX_ATTEMPTS = 3;

/** Interruptions (runs lost to orchestrator restarts) tolerated per ticket
 * before it is routed back to a human like an exhausted one. Counted
 * separately from attempts — a restart is the platform's downtime, never
 * charged to the ticket — and deliberately more generous than MAX_ATTEMPTS,
 * because merging any interlude PR restarts the orchestrator and routine
 * deploys must not burn unrelated tickets. The bound exists for the other
 * case: a ticket whose run crashes the orchestrator itself would otherwise
 * re-claim forever on the no-attempt-consumed exemption. */
export const MAX_INTERRUPTIONS_PER_TICKET = 5;

/** Implement↔review cycles allowed within one attempt: the initial pass and
 * its review, plus one fix-up bought by a request-changes verdict. A second
 * request-changes fails the attempt instead of looping. */
export const MAX_REVIEW_CYCLES_PER_ATTEMPT = 2;

/** Re-queues a review pass earns after returning an unparseable verdict
 * (issue #89). The common cause is a pure format slip — a substantively fine
 * review whose final message just didn't lead with a `VERDICT:` line — which
 * today fails closed terminally and costs a human intervention. One bounded
 * retry, with the parse failure fed back into the prompt, removes it. A second
 * unparseable verdict falls to the existing fail-closed path (nothing posted,
 * human oversight). Counted per attempt on runs.review_unparseable_count, so a
 * review that dies or slips its format once is retried, twice is a human's. */
export const MAX_UNPARSEABLE_REVIEW_RETRIES = 1;

/**
 * Resumes one attempt may have after a quota pause before its ticket is routed
 * to a human (issue #169) — the default the `MAX_RESUMES_PER_ATTEMPT`
 * environment variable and the settings screen both override.
 *
 * Three is the number of five-hour windows an attempt may span, and it is set
 * by what a pause *costs* rather than by what it risks: a pause spends no
 * attempt and no money, so the only thing an unbounded one wastes is the
 * ticket's own latency — while the thing the bound guards against is a
 * pathological ticket that walls the account on every single pass and would
 * otherwise cross windows forever. Three lets a genuinely long attempt run
 * overnight through consecutive windows; a fourth pause says the work is not
 * finishing on quota and a human should look.
 */
export const DEFAULT_MAX_RESUMES_PER_ATTEMPT = 3;

/** The most one attempt may be allowed, whatever the environment or the
 * settings screen says. Not a safety ceiling in the `FIXED_CEILINGS` sense —
 * nothing here spends money — but a bound on a bound, so a mistyped 50 cannot
 * turn a wedged ticket into a permanent one. It is also the vocabulary the
 * settings screen offers, so the environment and the UI accept exactly the
 * same values. */
export const MAX_RESUMES_CEILING = 5;

/**
 * How far past its window's reset a paused run's own offset may fall (issue
 * #169) — see resume-jitter.ts for why the offset is derived from the run id.
 *
 * Five minutes: long enough that a fleet-wide pause does not put every run on
 * one sweep tick, competing for the same slots against a window that has only
 * just reopened, and short enough that nobody watching a countdown wonders
 * whether the fleet has forgotten. Finer than the 30-second sweep would be
 * meaningless — the sweep is the resolution the whole spread is observed at.
 */
export const RESUME_JITTER_WINDOW_MS = 5 * 60_000;

/** Estate-wide daily autonomous spend cap in USD. Reaching it pauses pickup
 * until local midnight; interactive tasks (no run row) are exempt by
 * construction. */
export const DAILY_AUTONOMOUS_CAP_USD = 500;

/**
 * Fleet-health watchdog thresholds (issue #126). Defaults chosen in the parent
 * design (#115): a review owed for over half an hour, a pickup wedged for a few
 * minutes, and a queue poll loop (which should tick every 2s) gone quiet for a
 * couple of minutes are each surfaced as a needs-you card + one Discord ping.
 * Env-overridable in minutes via config.ts (`OWED_REVIEW_STALL_MINUTES`,
 * `PICKUP_WEDGED_MINUTES`, `QUEUE_HEARTBEAT_STALE_MINUTES`,
 * `OCCUPANCY_DIVERGED_MINUTES`, `UNDELIVERED_ANSWER_MINUTES`); kept here as ms
 * so the leaf that holds every tunable also holds these.
 */
export const DEFAULT_OWED_REVIEW_STALL_MS = 30 * 60_000;
export const DEFAULT_PICKUP_WEDGED_MS = 3 * 60_000;
export const DEFAULT_QUEUE_HEARTBEAT_STALE_MS = 2 * 60_000;
/**
 * Occupancy uncorroborated by real agent containers for this long is a phantom
 * slot (issue #152). Far longer than the pickup debounce on purpose, and set by
 * the worst *honest* case rather than the typical one: a task holds its slot
 * from the moment it is reserved, but its container does not exist until
 * `createWorkspaceContainer` returns — and that call runs `ensureImage` inside
 * itself, so the first task after an agent Dockerfile change waits out a full
 * agent-image build (apt, gh, a global npm install) on a 2-vCPU box before any
 * container exists to corroborate it. The cost of being wrong is asymmetric:
 * this card tells the operator to restart, which would kill exactly that
 * legitimately-provisioning task. Twenty minutes clears a cold build with room
 * to spare and still turns the ~1.5h invisible wedge of #151 into a card and a
 * ping with over an hour left. Warming the image at boot would let this drop.
 */
export const DEFAULT_OCCUPANCY_DIVERGED_MS = 20 * 60_000;

/**
 * How long an answer the owner has given may sit undelivered before the fleet
 * says so (issue #136, `UNDELIVERED_ANSWER_MINUTES`).
 *
 * Delivery is one 2s queue poll away, so ten minutes is three orders of
 * magnitude of slack — it cannot fire on a healthy resume, and it fires long
 * before an owner would think to go and check. The two things it catches both
 * look identical from the outside: a blocked run whose delivery path died with
 * its process, and a parked resume that memory admission keeps deferring.
 */
export const DEFAULT_UNDELIVERED_ANSWER_MS = 10 * 60_000;

/**
 * Default real-money daily cap in USD (issue #174) — the ceiling on cash spent
 * through a **metered** lane in one local day, whether that lane is primary,
 * an overflow target or reached by failover. Deliberately a different number
 * from DAILY_AUTONOMOUS_CAP_USD and not a fraction of it: that cap measures
 * quota-funded work, where $500/day is a statement about how hard a
 * fixed-price plan may be pushed, and this one measures a card being charged.
 * $20 is one full attempt's budget — a metered fleet gets a day's work out of
 * it and no surprises — and it is the same figure the metered lanes declare in
 * `lanes.yaml`, so the checked-in file and the compiled-in default agree.
 * Overridable per deployment via METERED_DAILY_CAP_USD, and from the settings
 * UI up to the ceiling below.
 */
export const DEFAULT_METERED_DAILY_CAP_USD = 20;

/**
 * Hard ceiling the settings UI may raise the real-money daily cap to (issue
 * #174). The same rule the per-attempt budget's $75 ceiling states, applied to
 * the one number that authorises spending actual money: a press on a web page
 * is not the place to widen a cash ceiling without bound. A deployment that
 * genuinely wants more sets METERED_DAILY_CAP_USD, which takes a config change
 * and a restart — the same bar every other safety ceiling here answers to.
 * Rejected by name in `FIXED_CEILINGS`, never clamped.
 */
export const MAX_METERED_DAILY_CAP_USD = 100;
