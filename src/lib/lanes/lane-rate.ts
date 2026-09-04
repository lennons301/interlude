/**
 * How a lane's rate is *said* (issues #176, #199) — one formatter and one
 * sentence, shared by every surface that quotes what a lane costs.
 *
 * The settings screen's routing row, the failover's issue comment and the
 * early resume's issue comment all quote the ranking's blended USD-per-Mtok
 * figure (`laneBlendedRateUsd`), and they must quote it the same way: the
 * #148 rule, applied to words rather than to a decision, because an operator
 * reading "$0.04/Mtok" on the screen and "$0.039 per million tokens" on the
 * issue would reasonably ask which one the fleet believed.
 *
 * A leaf on purpose — it imports a type and nothing else — so a client
 * component can import it without dragging the lane resolver, the quota store
 * or the database into the browser bundle.
 */

import type { LaneBilling } from "./lane-config";

/** Two significant figures, because these span three orders of magnitude and
 * "$0.04" beside "$1.65" is the whole comparison. */
export function formatUsdPerMTok(rate: number): string {
  if (rate === 0) return "$0";
  return `$${rate < 0.1 ? rate.toFixed(3) : rate.toFixed(2)}`;
}

/**
 * What running on a lane costs, in one sentence for an issue comment — the
 * promise every lane move makes (issues #176, #199): a crossing onto a paid
 * lane is never silent about the money.
 *
 * The rate is the ranking's own — USD per million tokens of a typical pass,
 * off the lane's declared prices — and it is said as "about", because it is a
 * ranking key rather than a forecast of this pass. A metered lane declaring no
 * prices is said to be exactly that, rather than dressed up with a number
 * nothing wrote down; a subscription target is said to cost nothing at the
 * margin, so a move that happens to land on one is not read as a bill.
 */
export function describeLaneCost(
  billing: LaneBilling,
  rateUsdPerMTok: number | null
): string {
  if (billing !== "metered") {
    return "That lane runs on subscription quota, so the move costs nothing at the margin.";
  }
  const rate =
    rateUsdPerMTok === null
      ? "at a rate it declares no prices for — the harness's own figure is charged —"
      : `at about ${formatUsdPerMTok(rateUsdPerMTok)} per million tokens of a typical pass,`;
  return `That lane bills real money ${rate} within today's confirmed real-money cap.`;
}
