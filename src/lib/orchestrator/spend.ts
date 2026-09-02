import { db } from "@/db";
import { meteredSpend, runs, tasks } from "@/db/schema";
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
 * The local calendar day an instant falls in, as `YYYY-MM-DD` — the key the
 * real-money ledger is written under (issue #174). Local, not UTC, because
 * that is the day boundary every other daily figure here resets at.
 */
export function localDayKey(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Add a turn's real-money cost to the day it was spent on (issue #174).
 *
 * The *delta* is what a caller has that is unambiguous: a task's stored cost is
 * a running total carrying no day, so a session spanning three days cannot be
 * attributed by any field on its row without either under-counting (spending
 * past the cash cap) or double-counting (holding the fleet over money it did
 * not spend today). Booking each increment as it lands sidesteps the guess
 * entirely, and books it to the lane that turn actually ran on.
 *
 * Idempotent by construction: the caller passes the old and new totals, so
 * writing the same total twice adds nothing. A decrease adds nothing either —
 * costs only ever accumulate, so a lower figure is a reset or a bug, and
 * neither is a refund.
 */
export function recordMeteredSpend(
  previousUsd: number,
  totalUsd: number,
  now: Date = new Date()
): void {
  const delta = totalUsd - previousUsd;
  if (!Number.isFinite(delta) || delta <= 0) return;
  const day = localDayKey(now);
  db.insert(meteredSpend)
    .values({ day, usd: delta, updatedAt: now })
    .onConflictDoUpdate({
      target: meteredSpend.day,
      set: {
        usd: sql`${meteredSpend.usd} + ${delta}`,
        updatedAt: now,
      },
    })
    .run();
}

/**
 * Book a task's new cumulative cost against the day, if that task's pass ran
 * on a lane that bills per token (issues #174, #173).
 *
 * The rule is a fact about a *task* — what it has spent so far, and who was
 * paying when it spent it — so it lives beside the ledger it writes rather
 * than at the cost-writing call sites: a later third caller cannot forget it,
 * and the rule can be exercised without a container.
 *
 * `laneBilling` is the pass's **effective** billing kind, which is why this
 * needs no opinion about overage: the turn manager records `metered` for a
 * pass an active overage is paying for (issue #173), so the dollars the card
 * is really being charged reach the cap whether the lane declares itself
 * metered or not. Nothing is exempt by kind — a chat session on a paid lane
 * charges the same card an implement pass does.
 */
export function bookTaskCost(
  taskId: string,
  totalUsd: number,
  now: Date = new Date()
): void {
  const before = db
    .select({ total: tasks.totalCostUsd, billing: tasks.laneBilling })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get();
  if (before?.billing !== "metered") return;
  recordMeteredSpend(before.total ?? 0, totalUsd, now);
}

/**
 * Real money spent on the local day containing `now` — the figure both the
 * cash cap and the dashboard's second gauge read.
 *
 * Deliberately a different shape from `todayAutonomousSpendUsd`, because it
 * answers a different question. That one measures autonomous work against a
 * quota-funded plan, so interactive tasks are exempt by construction. This one
 * measures a card being charged, so nothing is exempt by kind: a chat session
 * on a metered lane spends the same dollars an implement pass does, and a cap
 * that ignored them would not be measuring money. What *is* exempt is
 * subscription work, which never reaches the ledger at all.
 *
 * Reads a past day as readily as today, which is what lets the daily digest
 * report the day it covers rather than the day it is sent on.
 *
 * `now` is passed in, never read inside.
 */
export function todayMeteredSpendUsd(now: Date): number {
  const row = db
    .select()
    .from(meteredSpend)
    .where(eq(meteredSpend.day, localDayKey(now)))
    .get();
  return row?.usd ?? 0;
}
