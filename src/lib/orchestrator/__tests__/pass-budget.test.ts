import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/create-test-db";
import * as schema from "@/db/schema";
import { newId } from "@/lib/ulid";
import {
  DEFAULT_REPAIR_BUDGET_USD,
  DEFAULT_REVIEW_BUDGET_USD,
  DEFAULT_TRIAGE_BUDGET_USD,
  MAX_RESUMES_CEILING,
} from "../autonomy/budgets";

/**
 * What a pass may spend once quota pauses are in the picture (issue #169).
 *
 * A resume is a *new task row* for the same attempt, so every budget control
 * scoped to the row would hand it the whole per-attempt allowance again — the
 * defect these two functions exist to close. The walk runs against a real
 * migrated database, because lineage is a stored fact and the interesting cases
 * (a chain, a *distinct* pass of the same kind, a malformed row) are all shapes
 * of stored rows.
 */

let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

import { resolvePassBudget, spendCarriedIntoPass } from "../pass-budget";

let projectId: string;
let runId: string;

/** A work-carrying task on the run, optionally continuing an earlier one. */
function seedPass(opts: {
  kind: "implement" | "repair" | "review";
  costUsd: number;
  resumedFrom?: string | null;
}): string {
  const id = newId();
  testDb
    .insert(schema.tasks)
    .values({
      id,
      projectId,
      title: "Add the frobnicator",
      description: "the brief",
      status: "failed",
      kind: opts.kind,
      runId,
      totalCostUsd: opts.costUsd,
      resumedFromTaskId: opts.resumedFrom ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  return id;
}

beforeEach(() => {
  testDb = createTestDb().db;
  projectId = newId();
  testDb
    .insert(schema.projects)
    .values({ id: projectId, name: "lemons", createdAt: new Date() })
    .run();
  runId = newId();
  testDb
    .insert(schema.runs)
    .values({
      id: runId,
      projectId,
      githubIssue: "lennons301/lemons#34",
      attempt: 1,
      mode: "autonomous",
      status: "rate_limited",
      budgetUsd: 20,
      claimedAt: new Date(),
    })
    .run();
});

describe("the spend a resumed pass carries (issue #169)", () => {
  it("is nothing at all for a pass that is not a resume", () => {
    seedPass({ kind: "implement", costUsd: 18 });

    expect(spendCarriedIntoPass({ resumedFromTaskId: null })).toBe(0);
  });

  it("is what the pass it resumed spent", () => {
    const walled = seedPass({ kind: "implement", costUsd: 18 });

    expect(spendCarriedIntoPass({ resumedFromTaskId: walled })).toBe(18);
  });

  it("accumulates across a chain of resumes", () => {
    const first = seedPass({ kind: "implement", costUsd: 12 });
    const second = seedPass({ kind: "implement", costUsd: 4, resumedFrom: first });
    const third = seedPass({ kind: "implement", costUsd: 1.5, resumedFrom: second });

    // Resume 3 answers for everything the attempt spent on this pass, not just
    // the row before it: three stacked resumes are exactly how the per-attempt
    // ceiling would otherwise become four times itself.
    expect(spendCarriedIntoPass({ resumedFromTaskId: third })).toBe(17.5);
  });

  it("ignores the run's other passes, including one of the same kind", () => {
    // A run's review pass carries its own allowance, and a run can own two
    // *distinct* repair passes — each entitled to its own. Only lineage tells
    // "the same pass, continued" from "another pass of the same kind", which is
    // why the run cannot answer this question.
    seedPass({ kind: "review", costUsd: 4 });
    seedPass({ kind: "repair", costUsd: 4.5 });
    const walledRepair = seedPass({ kind: "repair", costUsd: 2 });

    expect(spendCarriedIntoPass({ resumedFromTaskId: walledRepair })).toBe(2);
  });

  it("stops at a predecessor that is no longer there", () => {
    expect(spendCarriedIntoPass({ resumedFromTaskId: newId() })).toBe(0);
  });

  it("terminates on a lineage cycle rather than hanging the pass", () => {
    const a = seedPass({ kind: "implement", costUsd: 3 });
    const b = seedPass({ kind: "implement", costUsd: 3, resumedFrom: a });
    testDb
      .update(schema.tasks)
      .set({ resumedFromTaskId: b })
      .where(eq(schema.tasks.id, a))
      .run();

    // Nothing writes a cycle; a hand-edited row could. The answer is allowed to
    // be wrong, but the walk is not allowed to be unbounded — a pass about to
    // start is waiting on it.
    const carried = spendCarriedIntoPass({ resumedFromTaskId: b });
    expect(carried).toBe(6);
  });

  it("stops walking past the resume ceiling", () => {
    let cursor: string | null = null;
    for (let i = 0; i < MAX_RESUMES_CEILING + 4; i++) {
      cursor = seedPass({ kind: "implement", costUsd: 1, resumedFrom: cursor });
    }

    // The chain a run can legitimately build is bounded by the ceiling, so the
    // walk is too: it reads at most one step past it.
    expect(spendCarriedIntoPass({ resumedFromTaskId: cursor })).toBe(
      MAX_RESUMES_CEILING + 1
    );
  });
});

describe("the allowance a pass runs on (issue #169)", () => {
  const cases: {
    name: string;
    kind: string;
    attemptBudgetUsd: number | null;
    carriedCostUsd: number;
    allowanceUsd: number | null;
    remainingUsd: number | null;
  }[] = [
    {
      name: "a first implement pass gets the whole attempt budget",
      kind: "implement",
      attemptBudgetUsd: 20,
      carriedCostUsd: 0,
      allowanceUsd: 20,
      remainingUsd: 20,
    },
    {
      name: "a resume of an attempt already $18 into $20 gets $2, not $20",
      kind: "implement",
      attemptBudgetUsd: 20,
      carriedCostUsd: 18,
      allowanceUsd: 20,
      remainingUsd: 2,
    },
    {
      name: "a raised budget is netted the same way",
      kind: "implement",
      attemptBudgetUsd: 75,
      carriedCostUsd: 60,
      allowanceUsd: 75,
      remainingUsd: 15,
    },
    {
      name: "a resumed repair pass draws on the repair allowance, netted",
      kind: "repair",
      attemptBudgetUsd: 20,
      carriedCostUsd: 3,
      allowanceUsd: DEFAULT_REPAIR_BUDGET_USD,
      remainingUsd: DEFAULT_REPAIR_BUDGET_USD - 3,
    },
    {
      name: "a review pass keeps its own allowance",
      kind: "review",
      attemptBudgetUsd: 20,
      carriedCostUsd: 0,
      allowanceUsd: DEFAULT_REVIEW_BUDGET_USD,
      remainingUsd: DEFAULT_REVIEW_BUDGET_USD,
    },
    {
      name: "a triage pass keeps the smallest of all",
      kind: "triage",
      attemptBudgetUsd: null,
      carriedCostUsd: 0,
      allowanceUsd: DEFAULT_TRIAGE_BUDGET_USD,
      remainingUsd: DEFAULT_TRIAGE_BUDGET_USD,
    },
    {
      name: "an interactive task has no allowance of its own",
      kind: "interactive",
      attemptBudgetUsd: null,
      carriedCostUsd: 0,
      allowanceUsd: null,
      remainingUsd: null,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const budget = resolvePassBudget({
        kind: c.kind,
        attemptBudgetUsd: c.attemptBudgetUsd,
        carriedCostUsd: c.carriedCostUsd,
      });

      expect(budget.allowanceUsd).toBe(c.allowanceUsd);
      expect(budget.remainingUsd).toBe(c.remainingUsd);
      expect(budget.carriedCostUsd).toBe(c.carriedCostUsd);
    });
  }

  it("reports nothing left when the predecessors spent the allowance", () => {
    // What the turn manager refuses to provision a container for: the pass has
    // no money, so there is nothing for a ~2 GiB container to run.
    const budget = resolvePassBudget({
      kind: "repair",
      attemptBudgetUsd: 20,
      carriedCostUsd: DEFAULT_REPAIR_BUDGET_USD,
    });

    expect(budget.remainingUsd).toBe(0);
  });
});
