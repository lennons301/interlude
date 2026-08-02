/**
 * Budget constants for autonomous passes. A leaf module — both the sweep
 * (claim time) and the turn manager (exec time) need these, and importing
 * either into the other would create a cycle. Issue #18 layers ticket
 * directives and clamping on top.
 */

/** Default per-attempt budget for an autonomous implement pass. */
export const DEFAULT_ATTEMPT_BUDGET_USD = 20;

/** Budget for one review pass — its own allowance, separate from the
 * implement attempt's, so reviewing never eats into a fix-up's headroom. */
export const DEFAULT_REVIEW_BUDGET_USD = 5;
