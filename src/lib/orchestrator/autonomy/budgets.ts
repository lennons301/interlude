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

/** Budget for one review pass — its own allowance, separate from the
 * implement attempt's, so reviewing never eats into a fix-up's headroom. */
export const DEFAULT_REVIEW_BUDGET_USD = 5;

/** Budget for one triage pass — shaping the backlog must cost a fraction of
 * implementing a ticket. */
export const DEFAULT_TRIAGE_BUDGET_USD = 2;

/** Per-exec turn cap for a triage pass: read the issue against the repo's
 * context, judge, exit. Not raisable — triage reads semi-trusted input and
 * has no directive surface. */
export const TRIAGE_MAX_TURNS = 15;

/** Attempts per ticket before it is routed back to a human
 * (`ready-for-agent` swapped for `ready-for-human`). */
export const MAX_ATTEMPTS = 3;

/** Implement↔review cycles allowed within one attempt: the initial pass and
 * its review, plus one fix-up bought by a request-changes verdict. A second
 * request-changes fails the attempt instead of looping. */
export const MAX_REVIEW_CYCLES_PER_ATTEMPT = 2;

/** Estate-wide daily autonomous spend cap in USD. Reaching it pauses pickup
 * until local midnight; interactive tasks (no run row) are exempt by
 * construction. */
export const DAILY_AUTONOMOUS_CAP_USD = 500;
