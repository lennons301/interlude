/**
 * The run ledger's status vocabulary, as the loop's two recovery-and-pickup
 * questions ask it. A leaf module with no imports, so both questions can be
 * answered — and tested — without loading Docker, Discord or the sweep.
 *
 * Both lists are **inclusion** lists, deliberately: a status added to the
 * ledger is, until someone says otherwise here, neither claimable-over nor
 * reclaimable-at-boot. That default is the safe one in both directions — a new
 * state cannot silently license a second run on the same ticket, nor be
 * re-claimed out from under whatever it was waiting for.
 */

/**
 * Run statuses that mean "this issue is being worked" — not re-claimable,
 * and (issue #24) its containers are off-limits to the reaper.
 *
 * `rate_limited` (issue #168) is here because the ticket is still this run's:
 * the pass was refused by the account's quota, not finished, and claiming a
 * second run over it would spend an attempt on a ticket already holding a
 * paused one. It owns no container to protect — the pause tears it down, since
 * a parked container holds memory without holding a slot (the 2026-08-04
 * incident) — so its presence in the reaper's keep-set is inert rather than
 * load-bearing.
 */
export const ACTIVE_RUN_STATUSES = [
  "claimed",
  "implementing",
  "reviewing",
  "gated",
  "blocked",
  "rate_limited",
] as const;

/**
 * The non-terminal run statuses boot recovery reclaims: a run in one of these
 * with no live turn is either interruptible (issue #24) or a dangling ghost
 * (issue #106).
 *
 * Deliberately excludes every terminal status and the three that are waiting on
 * something a restart did not destroy: `gated` and `blocked` wait on a human,
 * and `rate_limited` waits on a clock (issue #168). Re-claiming a paused run
 * would spend the attempt this ticket exists to protect, and failing it would
 * spend all three; marking it `interrupted` would bump a bound that measures
 * orchestrator restarts. Its `resumeAfter` outlives the process precisely so
 * that boot has nothing to work out.
 */
export const RECLAIMABLE_RUN_STATUSES = [
  "claimed",
  "implementing",
  "reviewing",
] as const;
