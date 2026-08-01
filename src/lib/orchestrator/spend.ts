import { db } from "@/db";
import { runs } from "@/db/schema";
import { gte, sql } from "drizzle-orm";

/** Start of the local calendar day containing `now` — the daily autonomous
 * spend cap resets at local midnight. */
export function startOfLocalDay(now: Date): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start;
}

/**
 * Today's autonomous spend in USD: one sum over runs claimed since local
 * midnight. Interactive tasks have no run, so they are exempt from the cap by
 * construction rather than by a filter. A run's spend is attributed to the day
 * it was claimed — an attempt's cost is bounded by the budget resolved at
 * claim time, so cross-midnight drift is at most one attempt's budget.
 *
 * `now` is passed in, never read inside, so decisions built on this stay
 * deterministic and table-testable.
 */
export function todayAutonomousSpendUsd(now: Date): number {
  const row = db
    .select({ total: sql<number>`coalesce(sum(${runs.totalCostUsd}), 0)` })
    .from(runs)
    .where(gte(runs.claimedAt, startOfLocalDay(now)))
    .get();
  return row?.total ?? 0;
}
