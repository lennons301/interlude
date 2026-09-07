import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/create-test-db";
import * as schema from "@/db/schema";
import { newId } from "@/lib/ulid";
import type { Action } from "../decide";
import { HUMAN_SIGNOFF_LABEL } from "../gates";

/**
 * What a gate decision does to the PR and the run (issues #16, #238), driven
 * over a real (in-memory, migrated) database with a stand-in for the PR as
 * GitHub holds it — armed or not, labelled or not — so the *ordering* of the
 * mutations and their effect on the PR's arm are observable.
 *
 * The reducer's table tests say what is decided from a pending evaluation;
 * these say what carrying that decision out writes. The case that matters is
 * the one that merged moontide#122 past its gate on 2026-09-06: the first head
 * matched no gates and armed auto-merge; a CI repair pushed a head touching
 * gated paths; the re-gate labelled `human-signoff` and said "auto-merge left
 * disarmed" — but never disarmed, and the standing arm fired on the reviewer's
 * approval.
 *
 * Only outbound I/O is stubbed (the PR mutations, the issue comment), and the
 * stubs keep the real helpers' contracts: the disarm is idempotent and reports
 * what it found, the arm refuses an already-armed PR so the executor's
 * re-read is exercised. The DB reads and writes are the real thing.
 */

let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

/** The PR as GitHub holds it, plus an ordered log of every mutation made to
 * it, because "disarm before label" is the property under test. */
const pr = vi.hoisted(() => ({
  autoMergeArmed: false,
  labels: [] as string[],
  mutations: [] as string[],
  disarmFails: false,
  labelFails: false,
}));

vi.mock("../../../github/pull-requests", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../github/pull-requests")>();
  return {
    ...actual,
    armAutoMergeSquash: async () => {
      pr.mutations.push("arm");
      // GitHub refuses to enable auto-merge on a PR that already has it; the
      // executor tolerates that by re-reading the PR's state.
      if (pr.autoMergeArmed) return false;
      pr.autoMergeArmed = true;
      return true;
    },
    disarmAutoMerge: async () => {
      pr.mutations.push("disarm");
      if (pr.disarmFails) return null;
      if (!pr.autoMergeArmed) return "already-disarmed";
      pr.autoMergeArmed = false;
      return "disarmed";
    },
    labelPr: async (_owner: string, _repo: string, _prNumber: number, label: string) => {
      pr.mutations.push(`label:${label}`);
      if (pr.labelFails) return false;
      pr.labels.push(label);
      return true;
    },
    getPrState: async () => ({
      open: true,
      merged: false,
      autoMergeArmed: pr.autoMergeArmed,
      mergeable: "mergeable",
      headSha: "ecf9a2d",
      checks: { state: "pending", failed: [] },
    }),
  };
});

const github = vi.hoisted(() => ({ comments: [] as string[] }));

vi.mock("../../../github/issues", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../github/issues")>();
  return {
    ...actual,
    commentOnIssue: async (_ref: string, body: string) => {
      github.comments.push(body);
      return true;
    },
  };
});

type GateDecision = typeof import("../gate-decision");

const ISSUE_REF = "lennons301/moontide#121";
const PR_NUMBER = 122;

let runId: string;

/** A run whose implement pass has settled with a PR up: what
 * `gatherPendingGateEvaluations` gathers. `checkpoint` null — autonomous. */
function seedRun(overrides: Partial<typeof schema.runs.$inferInsert> = {}): void {
  const projectId = newId();
  testDb
    .insert(schema.projects)
    .values({ id: projectId, name: "moontide", createdAt: new Date() })
    .run();
  runId = newId();
  testDb
    .insert(schema.runs)
    .values({
      id: runId,
      projectId,
      githubIssue: ISSUE_REF,
      attempt: 1,
      mode: "autonomous",
      status: "implementing",
      budgetUsd: 20,
      pullRequestNumber: PR_NUMBER,
      claimedAt: new Date(),
      startedAt: new Date(),
      ...overrides,
    })
    .run();
}

function run() {
  return testDb.select().from(schema.runs).where(eq(schema.runs.id, runId)).get()!;
}

/** The reducer's `gatePr` for this run: the categories `evaluateGates` named
 * for the head, and the run's checkpoint. Nothing about the PR's arm is
 * carried — the executor finds that out for itself. */
function gatePr(categories: string[]): Extract<Action, { type: "gatePr" }> {
  return {
    type: "gatePr",
    runId,
    issueRef: ISSUE_REF,
    prNumber: PR_NUMBER,
    categories,
    checkpoint: run().checkpoint,
  };
}

function armAutoMerge(): Extract<Action, { type: "armAutoMerge" }> {
  return { type: "armAutoMerge", runId, issueRef: ISSUE_REF, prNumber: PR_NUMBER };
}

/** The repair pass's effect on the run between two heads: back to
 * `implementing`, its previous cycle's verdict cleared (what `queueRepairPass`
 * writes), so the sweep gathers it for gate evaluation again. */
function repairPushesNewHead(): void {
  testDb
    .update(schema.runs)
    .set({ status: "implementing", reviewVerdict: null, reviewResult: null })
    .where(eq(schema.runs.id, runId))
    .run();
}

describe("carrying out a gate decision (issues #16, #238)", () => {
  let gateDecision: GateDecision;

  beforeEach(async () => {
    testDb = createTestDb().db;
    pr.autoMergeArmed = false;
    pr.labels.length = 0;
    pr.mutations.length = 0;
    pr.disarmFails = false;
    pr.labelFails = false;
    github.comments.length = 0;
    gateDecision = await import("../gate-decision");
  });

  it("disarms a PR an earlier ungated head armed when a later head gates it (issue #238)", async () => {
    seedRun();

    // The first head — one docs file — matches no gates and arms auto-merge.
    await gateDecision.executeArmAutoMerge(armAutoMerge());
    expect(pr.autoMergeArmed).toBe(true);
    expect(run().status).toBe("reviewing");

    // CI goes red; the repair pass pushes a head touching a CI workflow and a
    // migration — gated paths — and the sweep gathers the run for gate
    // evaluation again. The PR it is deciding about is still armed.
    repairPushesNewHead();
    await gateDecision.executeGatePr(gatePr(["ci-secrets", "data-migrations"]));

    // The property: auto-merge is disabled, and it was disabled *before* the
    // label went on — nothing is ever labelled gated while still armed.
    expect(pr.autoMergeArmed).toBe(false);
    expect(pr.mutations).toEqual(["arm", "disarm", `label:${HUMAN_SIGNOFF_LABEL}`]);
    expect(pr.labels).toEqual([HUMAN_SIGNOFF_LABEL]);

    const gated = run();
    expect(gated.status).toBe("gated");
    expect(gated.gateCategories).toEqual(["ci-secrets", "data-migrations"]);
    expect(gated.reviewVerdict).toBeNull();
    expect(gated.reviewedHeadSha).toBeNull();

    // And the comment says what happened, not what was assumed.
    expect(github.comments).toHaveLength(2);
    expect(github.comments[1]).toContain("touches **ci-secrets, data-migrations**");
    expect(github.comments[1]).toContain("auto-merge disarmed");
    expect(github.comments[1]).not.toContain("left disarmed");
  });

  it("still asks for the disarm on a PR gated on its first head — idempotent — and says auto-merge was left disarmed", async () => {
    // Unconditional, because the executor trusts no earlier reading of the
    // arm: a webhook sweep beside the interval one, or a human's toggle, can
    // make a fact read at gather time stale by now.
    seedRun();

    await gateDecision.executeGatePr(gatePr(["data-migrations"]));

    expect(pr.mutations).toEqual(["disarm", `label:${HUMAN_SIGNOFF_LABEL}`]);
    expect(pr.autoMergeArmed).toBe(false);
    expect(run().status).toBe("gated");
    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]).toContain("auto-merge left disarmed");
  });

  it("leaves the run pending when the disarm fails — the label never goes on over a standing arm", async () => {
    seedRun();
    pr.autoMergeArmed = true;
    pr.disarmFails = true;

    await gateDecision.executeGatePr(gatePr(["ci-secrets"]));

    expect(pr.mutations).toEqual(["disarm"]);
    expect(pr.labels).toEqual([]);
    expect(pr.autoMergeArmed).toBe(true);
    expect(run().status).toBe("implementing");
    expect(run().gateCategories).toEqual([]);
    expect(github.comments).toEqual([]);
  });

  it("still leaves the run pending when the label fails after a disarm — the next sweep retries the step", async () => {
    // The disarm is idempotent on an unarmed PR, so retrying the whole step
    // costs nothing and the run is never gated without its label.
    seedRun();
    pr.autoMergeArmed = true;
    pr.labelFails = true;

    await gateDecision.executeGatePr(gatePr(["data-migrations"]));

    expect(pr.mutations).toEqual(["disarm", `label:${HUMAN_SIGNOFF_LABEL}`]);
    expect(pr.autoMergeArmed).toBe(false);
    expect(run().status).toBe("implementing");
    expect(github.comments).toEqual([]);
  });

  it("disarms a supervised re-gate too, and the checkpoint comment says so", async () => {
    // A checkpoint: run gates whatever the globs say; on a later head it is
    // armed for the same reason an autonomous one is, and the same disarm
    // applies. The comment keeps leading with the decision being waited on.
    seedRun({ mode: "supervised", checkpoint: "confirm the seed change with me" });
    pr.autoMergeArmed = true;

    await gateDecision.executeGatePr(gatePr(["data-migrations"]));

    expect(pr.mutations).toEqual(["disarm", `label:${HUMAN_SIGNOFF_LABEL}`]);
    expect(pr.autoMergeArmed).toBe(false);
    expect(run().status).toBe("gated");
    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]).toMatch(/^Checkpoint: this ticket runs supervised/);
    expect(github.comments[0]).toContain("with auto-merge disarmed, regardless of gate");
    expect(github.comments[0]).toContain("> confirm the seed change with me");
    expect(github.comments[0]).toContain("It also touches **data-migrations**.");
  });

  it("re-arms an armed PR whose later head is still ungated by re-reading its state, and leaves it armed", async () => {
    // The other half of a repair's push: off every gated path, the PR is
    // simply armed again. GitHub refuses the second enable, the executor
    // reads the PR and finds it armed, and the run goes back to review.
    seedRun({ status: "reviewing" });
    pr.autoMergeArmed = true;
    repairPushesNewHead();

    await gateDecision.executeArmAutoMerge(armAutoMerge());

    expect(pr.mutations).toEqual(["arm"]);
    expect(pr.autoMergeArmed).toBe(true);
    expect(run().status).toBe("reviewing");
    expect(github.comments[0]).toContain("matched no gates — auto-merge (squash) armed");
  });
});
