import { eq } from "drizzle-orm";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import {
  DEFAULT_REPAIR_BUDGET_USD,
  DEFAULT_REVIEW_BUDGET_USD,
  DEFAULT_TRIAGE_BUDGET_USD,
  MAX_RESUMES_CEILING,
} from "./autonomy/budgets";

/** What a pass may spend, and what its predecessors already did.
 *
 * `allowanceUsd` is the pass kind's own gross allowance; `remainingUsd` is that
 * allowance net of `carriedCostUsd`, and is what reaches the harness. Both are
 * null for a task with no allowance of its own — an interactive task, which
 * answers to the configured per-task default instead. */
export type PassBudget = {
  allowanceUsd: number | null;
  carriedCostUsd: number;
  remainingUsd: number | null;
};

/**
 * What one pass may spend, net of the quota pauses it was resumed from
 * (issue #169).
 *
 * A resumed pass is a *new task row* for the same attempt, and every budget
 * control in the turn manager is scoped to the task: the cap handed to the
 * harness, the pre-turn check and the exhaustion judgement all read
 * `tasks.totalCostUsd`, which starts at zero. Left at the row, one attempt's
 * real ceiling would be `(1 + resumes) x run.budgetUsd` — $80 by default, $300
 * for a ticket carrying a `budget:` directive — which is not what
 * `MAX_ATTEMPT_BUDGET_USD` calls a *hard* ceiling. And this is the one path
 * where that spend would accrue with no pickup gate in front of it, since a
 * resume is deliberately exempt from the daily cap.
 *
 * So the **attempt's** budget follows the pass rather than the row. Which
 * allowance a pass draws on is unchanged: an implement pass the run's
 * per-attempt budget, a review pass its own smaller one, a triage pass the
 * smallest of all, a repair pass its own — and an interactive task none of
 * them, answering to the configured per-task default instead.
 *
 * Only the attempt's budget is netted, which is deliberate. A repair pass
 * (issue #54) is *never an attempt*: it carries its own modest allowance, it is
 * bounded per conflict episode rather than per attempt, and it may not fail the
 * run — a repair that spends its allowance without clearing the conflict parks,
 * and the sweep escalates the still-conflicting PR to a human. Netting its $5
 * would hand a resumed repair pass small change to merge a branch with, and a
 * refusal on the way in would have to fail an attempt a repair pass is not
 * allowed to spend. What that leaves open is bounded and much smaller than what
 * it closes: a resumed repair pass gets its $5 again, at most
 * `MAX_RESUMES_CEILING` times. Closing it properly means giving repair one
 * allowance per conflict episode across rows — including the fix-up turns that
 * already charge against `run.budgetUsd` rather than the $5 — which is #54's
 * accounting to settle, not this ticket's.
 */
export function resolvePassBudget(pass: {
  kind: string;
  attemptBudgetUsd: number | null;
  carriedCostUsd: number;
}): PassBudget {
  // Null = "this kind has no allowance of its own": it draws on the attempt's,
  // and so is the only kind whose budget is netted below.
  const ownAllowanceUsd =
    pass.kind === "review"
      ? DEFAULT_REVIEW_BUDGET_USD
      : pass.kind === "triage"
        ? DEFAULT_TRIAGE_BUDGET_USD
        : pass.kind === "repair"
          ? DEFAULT_REPAIR_BUDGET_USD
          : null;
  const allowanceUsd = ownAllowanceUsd ?? pass.attemptBudgetUsd;
  const carriedCostUsd = ownAllowanceUsd === null ? pass.carriedCostUsd : 0;

  return {
    allowanceUsd,
    carriedCostUsd,
    remainingUsd: allowanceUsd === null ? null : allowanceUsd - carriedCostUsd,
  };
}

/**
 * What this pass already spent under the rows it was resumed from.
 *
 * Lineage (`tasks.resumedFromTaskId`) is what answers this, and the run cannot:
 * the run also owns review passes carrying their own allowance, and it may own
 * two *distinct* repair passes, each entitled to its own — so summing the run's
 * implement-shaped tasks would confuse "the same pass, continued" with "another
 * pass of the same kind". Only the chain distinguishes them.
 *
 * The walk is bounded by the resume ceiling, so a lineage cycle — which nothing
 * writes, but which a hand-edited row could — costs a bounded read rather than
 * hanging the pass about to start.
 */
export function spendCarriedIntoPass(task: { resumedFromTaskId: string | null }): number {
  let carried = 0;
  let cursor = task.resumedFromTaskId;
  const seen = new Set<string>();

  // One step past the ceiling: a legitimate chain is at most
  // `MAX_RESUMES_CEILING` long, so anything beyond it is a malformed row.
  for (let step = 0; cursor !== null && step <= MAX_RESUMES_CEILING; step++) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const previous = db
      .select({ cost: tasks.totalCostUsd, previousId: tasks.resumedFromTaskId })
      .from(tasks)
      .where(eq(tasks.id, cursor))
      .get();
    if (!previous) break;
    carried += previous.cost ?? 0;
    cursor = previous.previousId;
  }

  return carried;
}
