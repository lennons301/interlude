/**
 * What one turn cost, decided by the lane rather than by the harness (issue
 * #175).
 *
 * The whole milestone's spend machinery — the per-attempt budget, the daily
 * autonomous cap, issue #174's real-money cap — reads one number off a turn.
 * Before this ticket that number was whatever the harness put in its own
 * `total_cost_usd`, which is correct on a first-party lane and *fiction*
 * anywhere else. Measured on 2026-09-02, one turn through OpenRouter's
 * compatibility endpoint on a **free** model:
 *
 *     total_cost_usd: 0.194985
 *     modelUsage: { inputTokens: 38387, outputTokens: 122,
 *                   costBasis: "unknown", provider: "firstParty" }
 *
 * 38387 x $5/Mtok + 122 x $25/Mtok is exactly 0.194985 — the harness priced an
 * open-weights model it had never heard of at its own provider's list rates. The real
 * cost was $0.00 (free variant), or $0.0117 on the paid slug: an overstatement
 * of 16.7x. That is not a rounding problem; it is the difference between "this
 * lane is 40x cheaper" and "this lane blew the attempt budget", which would
 * defeat the entire purpose of having the lane.
 *
 * So: **a lane that declares prices is charged from its own prices**, applied
 * to the token counts the harness reported. Pure, so every rule is testable
 * with no provider:
 *
 *  - No declared prices -> the harness's figure stands. That is the honest
 *    answer for a first-party lane, where the harness prices a model it
 *    recognises at that model's list rates (it says so: `costBasis: "list"`).
 *  - Declared prices and reported tokens -> derived, and the harness's figure
 *    is kept beside it so a surprising bill is debuggable.
 *  - Declared prices that could not be applied — no reported tokens, or a
 *    pinned model at no priced tier -> the harness's figure, which on a
 *    third-party lane is an overstatement. Deliberately: this is a money
 *    guard, and over-reporting stops work early, while under-reporting spends
 *    money nobody authorised. The basis says which happened, and says it
 *    apart from the honest `harness` case, because "the CLI is right here"
 *    and "the CLI is all we have here" call for different reading.
 */

import type { TokenPrices } from "./lane-config";
import type { ResolvedLane } from "./resolve";

/**
 * The tokens one turn consumed, as the harness reported them.
 *
 * Four counts because all four are priced differently by every provider in the
 * field, and a cache read is an order of magnitude cheaper than fresh input —
 * on a long agentic pass the cache columns are the dominant term, not a
 * detail.
 */
export interface TurnTokenUsage {
  /** Uncached input tokens. Excludes the two cache counts, which the wire
   * reports separately. */
  inputTokens: number;
  /** Output tokens, thinking tokens included (the wire counts them there). */
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Where a charged figure came from — carried into the feed and the PR-facing
 * record, because "why does this pass say $0.01 when the CLI said $0.19?" is a
 * question an operator will ask exactly once if the answer is written down. */
export type TurnCostBasis =
  /** The harness's own `total_cost_usd`; the lane declares no prices, so that
   * figure is the lane's own list price and correct. */
  | "harness"
  /** Derived from the lane's declared prices and the reported token counts. */
  | "lane-prices"
  /** The lane declares prices but they could not be applied to this turn — it
   * reported no token counts, or it ran a pinned model at no priced tier — so
   * the harness's figure stands, knowingly, as the safe overstatement. */
  | "harness-unpriced";

export interface TurnCharge {
  /** What this turn is charged against every budget in the fleet. */
  usd: number;
  basis: TurnCostBasis;
  /** What the harness said, always — the figure `usd` replaced, or repeated. */
  reportedUsd: number;
}

const PER_MTOK = 1_000_000;

/**
 * What one turn costs on a lane, from the lane's own prices where it has them.
 *
 * `usage` is null when the turn produced no terminal result to read counts
 * from (a killed container, a lost stream) — the case the `harness-unpriced`
 * basis exists for.
 */
export function chargeForTurn(
  lane: Pick<ResolvedLane, "prices" | "declaresPrices">,
  reported: { costUsd: number; usage: TurnTokenUsage | null }
): TurnCharge {
  const reportedUsd = reported.costUsd;
  const prices = lane.prices;

  // Two questions, and both are asked: does the lane price its provider at
  // all, and does it price *this* pass? A lane running a pinned model answers
  // yes then no — it has prices but no tier to read them at — and calling that
  // `harness` would report the CLI's figure as the lane's own list price,
  // which on a third-party endpoint is the fiction this module exists to
  // replace.
  if (!lane.declaresPrices) {
    return { usd: reportedUsd, basis: "harness", reportedUsd };
  }
  if (prices === null || reported.usage === null) {
    return { usd: reportedUsd, basis: "harness-unpriced", reportedUsd };
  }

  return {
    usd: priceTokens(prices, reported.usage),
    basis: "lane-prices",
    reportedUsd,
  };
}

/**
 * The lane's prices applied to a turn's token counts.
 *
 * An unpriced cache column is charged at the input rate, not at zero: a
 * provider that publishes no cache-read discount is charging full price for
 * those tokens, and reading "not priced apart" as "free" would understate
 * spend on exactly the lanes where spend is real money.
 */
export function priceTokens(
  prices: TokenPrices,
  usage: TurnTokenUsage
): number {
  const cacheRead = prices.cacheReadPerMTok ?? prices.inputPerMTok;
  const cacheWrite = prices.cacheWritePerMTok ?? prices.inputPerMTok;
  return (
    (usage.inputTokens * prices.inputPerMTok +
      usage.outputTokens * prices.outputPerMTok +
      usage.cacheReadTokens * cacheRead +
      usage.cacheWriteTokens * cacheWrite) /
    PER_MTOK
  );
}

/**
 * How much the harness's figure differs from the charged one, as a multiple —
 * or null when there is nothing to compare (the bases where the two are the
 * same number, or a charged zero, which has no ratio).
 *
 * Its own function because it is the thing worth *saying*: "$0.0117 (the
 * harness said $0.1950, 16.7x)" tells an operator the lane is working and the
 * CLI is not, whereas two bare figures leave them to divide.
 */
export function costOverstatement(charge: TurnCharge): number | null {
  if (charge.basis !== "lane-prices") return null;
  if (charge.usd <= 0 || charge.reportedUsd <= 0) return null;
  return charge.reportedUsd / charge.usd;
}
