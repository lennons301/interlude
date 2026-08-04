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

/** Model tiers a ticket's `model:` directive may select (issue #80). A ticket
 * body is semi-trusted input, so it may only choose from this fixed set of
 * aliases — never name an arbitrary model string — mirroring the reasoning
 * behind the $75 budget clamp. The alias reaches the CLI as `--model`; an
 * unrecognised value is ignored (the run keeps its default model), never
 * fatal. Clamped in the directive parser, resolved through `resolveAgentModel`. */
export const ALLOWED_TICKET_MODELS = ["opus", "sonnet", "haiku"] as const;

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

/** Estate-wide daily autonomous spend cap in USD. Reaching it pauses pickup
 * until local midnight; interactive tasks (no run row) are exempt by
 * construction. */
export const DAILY_AUTONOMOUS_CAP_USD = 500;
