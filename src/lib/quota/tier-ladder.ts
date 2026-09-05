/**
 * The tier degrade ladder (issue #170): losing one tier's allowance steps the
 * fleet down a tier and carries on, rather than stopping it.
 *
 * #168 taught the fleet that a refused pass is not a failed attempt. This
 * module is the observation that follows from it: the CLI's own limit
 * vocabulary distinguishes a **tier-scoped** window (`seven_day_opus`,
 * `seven_day_sonnet`) from an **account-wide** one (`five_hour`, `seven_day`,
 * `overage`), and exhausting a tier-scoped one does not mean no work can run —
 * it means *that tier's* work cannot run. So the ladder
 * `heavy → standard → light` still has rungs below, and stepping onto one and
 * retrying beats waiting out a seven-day window.
 *
 * Two rules, and both are about not making things worse:
 *
 *  - **Account-wide, or unrecognised, is not tier-scoped.** A window this
 *    build has never heard of pauses the run exactly as `five_hour` does —
 *    the same argument `rate-limit-event.ts` makes for holding enums verbatim,
 *    read from the other end: a member we cannot interpret must fall back to
 *    the *cautious* behaviour, not the clever one. Stepping down on a window
 *    that was in fact account-wide would spend a second pass to learn nothing.
 *  - **Never step onto a rung the wall already covers.** The tier that ran and
 *    the tier the exhausted window names are both unavailable, so the next
 *    rung is the first one strictly below *both*. Without that, a
 *    `seven_day_sonnet` rejection observed on a heavy pass would step heavy →
 *    standard, straight into the window that just refused.
 *
 * Pure, total and leaf — it imports only the tier vocabulary, so the reducer
 * that expresses the decision (`decideNext`) can be table-tested against every
 * limit type without a database, a container or a clock.
 */

import { MODEL_TIERS, normalizeModelTier, type ModelTier } from "../model-tiers";

/**
 * The tier a limit window is scoped to, or null when it is account-wide (or
 * names no tier this build can read).
 *
 * **Derived, not enumerated.** The CLI's tier-scoped windows are named
 * `<window>_<model alias>` — `seven_day_opus`, `seven_day_sonnet` — so the
 * trailing segment is read through the same `normalizeModelTier` a ticket's
 * `model:` directive goes through. A window a later CLI adds for a tier we
 * already know (`seven_day_haiku`, `five_hour_opus`) is therefore understood
 * on arrival, and one naming something else (`seven_day_overage_included`,
 * whose last segment is `included`) reads as account-wide, which is the safe
 * answer.
 */
export function limitScopeTier(limitType: string): ModelTier | null {
  const trailing = limitType.slice(limitType.lastIndexOf("_") + 1);
  return normalizeModelTier(trailing);
}

/** A step down the ladder: the tier the pass ran at, and the tier its retry
 * runs at. */
export interface TierDegrade {
  from: ModelTier;
  to: ModelTier;
}

/**
 * The step a tier-scoped rejection buys, or null when there is none — in which
 * case the rejection is the account's, not a tier's, and the run pauses.
 *
 * Null covers four distinct cases, all of which end the same way on purpose:
 *
 *  - the window is account-wide (or unreadable), so no tier is exhausted;
 *  - the pass ran at **no known tier** — the deployment pins a raw model id
 *    (`AGENT_MODEL=<a provider's model id>`), or names no model at all and lets the
 *    harness choose. There is no rung to step from, and inventing one would
 *    override a pin an operator set deliberately;
 *  - the pass already ran at the bottom of the ladder;
 *  - the exhausted window names the bottom of the ladder, so there is nothing
 *    below both it and the pass.
 */
export function planTierDegrade(
  ranAt: ModelTier | null,
  limitType: string
): TierDegrade | null {
  if (ranAt === null) return null;
  const exhausted = limitScopeTier(limitType);
  if (exhausted === null) return null;

  // Both tiers are spent, so the next rung is the first strictly below the
  // *lower* of them — the larger index, the list being ordered most to least
  // capable.
  const floor = Math.max(MODEL_TIERS.indexOf(ranAt), MODEL_TIERS.indexOf(exhausted));
  const next = MODEL_TIERS[floor + 1];
  return next === undefined ? null : { from: ranAt, to: next };
}
