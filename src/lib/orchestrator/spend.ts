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

/**
 * Today's **real money**: a sum over every task whose recorded execution lane
 * bills per token (issue #174), created since local midnight.
 *
 * Deliberately a different shape from the sum above, because it answers a
 * different question. That one measures autonomous work against a
 * quota-funded plan, so interactive tasks are exempt by construction. This one
 * measures a card being charged, so nothing is exempt by kind: a chat session
 * on a metered primary lane spends the same dollars an implement pass does,
 * and a cap that ignored them would not be measuring money. What *is* exempt
 * is subscription work — every task run on a subscription lane, and every task
 * that predates lanes (null billing), neither of which cost cash.
 *
 * Summed over tasks rather than runs because the task is the unit money is
 * spent by: a run's cost is the sum of its tasks' anyway (`syncRunCost`), and
 * triage and interactive tasks own no run at all. Attributed to the day the
 * task was created, matching the rule above — each unit's cost is bounded by
 * the budget resolved at that moment, so cross-midnight drift is at most one
 * budget.
 *
 * `now` is passed in, never read inside.
 */
export function todayMeteredSpendUsd(now: Date): number {
  const start = startOfLocalDay(now);
  const row = db
    .select({ total: sql<number>`coalesce(sum(${tasks.totalCostUsd}), 0)` })
    .from(tasks)
    .where(and(eq(tasks.laneBilling, "metered"), gte(tasks.createdAt, start)))
    .get();
  return row?.total ?? 0;
}
