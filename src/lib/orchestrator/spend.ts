import { db } from "@/db";
import { runs, tasks } from "@/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";

/** Start of the local calendar day containing `now` — the daily autonomous
 * spend cap resets at local midnight. */
export function startOfLocalDay(now: Date): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start;
}

/**
 * Today's autonomous spend in USD: a sum over runs claimed since local
 * midnight, plus triage tasks created since then. Interactive tasks have no
 * run and are not triage, so they are exempt from the cap by construction
 * rather than by a filter; triage passes own no run (they are not attempts
 * at a ticket) but their spend is autonomous spend all the same, and
 * run-owned tasks are already counted through their run's totalCostUsd, so
 * nothing is counted twice. Spend is attributed to the day the work was
 * claimed/created — each unit's cost is bounded by the budget resolved at
 * that moment, so cross-midnight drift is at most one budget.
 *
 * `now` is passed in, never read inside, so decisions built on this stay
 * deterministic and table-testable.
 */
export function todayAutonomousSpendUsd(now: Date): number {
  const start = startOfLocalDay(now);
  const runRow = db
    .select({ total: sql<number>`coalesce(sum(${runs.totalCostUsd}), 0)` })
    .from(runs)
    .where(gte(runs.claimedAt, start))
    .get();
  const triageRow = db
    .select({ total: sql<number>`coalesce(sum(${tasks.totalCostUsd}), 0)` })
    .from(tasks)
    .where(and(eq(tasks.kind, "triage"), gte(tasks.createdAt, start)))
    .get();
  return (runRow?.total ?? 0) + (triageRow?.total ?? 0);
}
