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
