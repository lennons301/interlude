import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/create-test-db";
import * as schema from "@/db/schema";
import { newId } from "@/lib/ulid";

/**
 * What a *tier-scoped* quota wall does to the run ledger (issue #170), driven
 * through the real pass-completion seam over a real (in-memory, migrated)
 * database — the sibling of `quota-pause.test.ts`, which does the same for the
 * account-wide wall that stops the run.
 *
 * The reducer's table tests say what is *decided*; these say what is *written*,
 * which is where this ticket's promises live and where none of them are
 * observable from the reducer: the run retries (a fresh queued pass exists),
 * it retries a tier lower (`runs.model`), the ledger still knows what it was
 * asked for (`runs.degraded_from`), and none of it costs an attempt.
 *
 * Only outbound I/O is stubbed (Docker, GitHub). The DB writes, their ordering
 * and the container teardown are the real thing.
 */

let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const docker = vi.hoisted(() => ({
  calls: [] as string[],
}));

vi.mock("../../docker/container-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../docker/container-manager")>();
  return {
    ...actual,
    observeContainerAbsent: async () => false,
    startContainer: async () => docker.calls.push("startContainer"),
    stopContainer: async () => docker.calls.push("stopContainer"),
    removeContainer: async () => docker.calls.push("removeContainer"),
    execFallbackCommitAndPush: async () => docker.calls.push("push"),
  };
});

const github = vi.hoisted(() => ({ comments: [] as string[] }));

vi.mock("../../github/issues", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../github/issues")>();
  return {
    ...actual,
    commentOnIssue: async (_ref: string, body: string) => {
      github.comments.push(body);
      return undefined;
    },
  };
});

vi.mock("../../discord/notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../discord/notifications")>();
  return {
    ...actual,
    notifyRunBlocked: async () => null,
    notifyTaskFailed: async () => null,
  };
});

type TurnManager = typeof import("../turn-manager");

const ISSUE_REF = "lennons301/lemons#34";
const RESETS_AT_EPOCH = 1788310954;
const RESUME_AFTER = new Date(RESETS_AT_EPOCH * 1000);
const PROMPT = "Implement issue #34 — add the frobnicator.";

/** The turn the adapter hands back when the *heavy tier's* weekly allowance
 * is spent: the same refusal as any other wall, distinguished only by the
 * window the rate-limit event named — carried verbatim on the normalised
 * outcome (issue #214). */
function walledOn(rateLimitType: string, resetsAt: Date | null = RESUME_AFTER) {
  return {
    finalMessage: "You've hit your weekly limit for Opus · resets Monday",
    outcome: {
      kind: "refused" as const,
      refusal: { kind: "quota" as const, resumeAfter: resetsAt, limitType: rateLimitType },
    },
  };
}

let projectId: string;
let runId: string;
let taskId: string;

/** An implement pass mid-attempt on the heavy tier: attempt 2 of 3, one
 * interruption already on the ledger, so both counters would be visibly wrong
 * if a step down the ladder touched them. */
function seedImplementPass(model: string | null = "heavy"): void {
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
      githubIssue: ISSUE_REF,
      attempt: 2,
      mode: "autonomous",
      status: "implementing",
      budgetUsd: 20,
      model,
      lane: "claude-subscription",
      interruptionCount: 1,
      claimedAt: new Date(),
      startedAt: new Date(),
    })
    .run();
  taskId = newId();
  testDb
    .insert(schema.tasks)
    .values({
      id: taskId,
      projectId,
      title: "Add the frobnicator",
      description: PROMPT,
      status: "running",
      kind: "implement",
      runId,
      githubIssue: ISSUE_REF,
      branch: "agent/issue-34",
      containerStatus: "running",
      containerId: "abc123",
      containerName: "interlude-task-frob",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
}

function run() {
  return testDb.select().from(schema.runs).where(eq(schema.runs.id, runId)).get()!;
}

function task() {
  return testDb.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get()!;
}

/** The pass queued to replace the refused one, if any. */
function retryTask() {
  return testDb
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.status, "queued"))
    .all();
}

function systemMessages(): string[] {
  return testDb
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.taskId, taskId))
    .all()
    .map((m) => {
      try {
        return JSON.parse(m.content).text as string;
      } catch {
        return m.content;
      }
    });
}

describe("an implement pass refused on a tier's own allowance (issue #170)", () => {
  let turns: TurnManager;

  async function bootWith(model: string | null = "heavy") {
    testDb = createTestDb().db;
    docker.calls.length = 0;
    github.comments.length = 0;
    vi.resetModules();
    turns = await import("../turn-manager");
    turns.getActiveTasks().clear();
    seedImplementPass(model);
    turns.getActiveTasks().set(taskId, {
      container: {
        id: "abc123",
        name: "interlude-task-frob",
        previewSubdomain: "task-frob",
        container: {} as never,
      },
      state: "running",
      kind: "implement",
    });
  }

  beforeEach(async () => {
    await bootWith("heavy");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("steps the run down a tier and keeps it running rather than parking it", async () => {
    const decision = await turns.evaluatePassOutcome(taskId, walledOn("seven_day_opus"));

    expect(decision).toBe("degraded");
    expect(run().model).toBe("standard");
    // Emphatically not the pause: the account still has quota one rung down,
    // and `rate_limited` would sit this run out for up to seven days.
    expect(run().status).toBe("implementing");
    expect(run().resumeAfter).toBeNull();
    expect(run().finishedAt).toBeNull();
    expect(run().failureReason).toBeNull();
  });

  it("queues a fresh pass of the same kind, carrying the same work", async () => {
    await turns.evaluatePassOutcome(taskId, walledOn("seven_day_opus"));

    const retries = retryTask();
    expect(retries).toHaveLength(1);
    const retry = retries[0];
    expect(retry.runId).toBe(runId);
    expect(retry.kind).toBe("implement");
    // The work has not changed, only the tier it runs on — so the prompt, the
    // branch and the ticket ride across verbatim. `startTask` will resolve the
    // lane through `runs.model`, which now names the lower tier.
    expect(retry.description).toBe(PROMPT);
    expect(retry.branch).toBe("agent/issue-34");
    expect(retry.githubIssue).toBe(ISSUE_REF);
  });

  it("keeps the attempt's budget on the retry rather than handing out a fresh one", async () => {
    await turns.evaluatePassOutcome(taskId, walledOn("seven_day_opus"));

    // The retry is a *second* implement-shaped task row under one run, and
    // every budget control in the turn manager is scoped to the row. Without
    // the lineage #169 introduced, a run that stepped twice would be handed the
    // whole per-attempt allowance three times over.
    expect(retryTask()[0].resumedFromTaskId).toBe(taskId);
  });

  it("records the tier it was asked for, so the ledger stays interpretable", async () => {
    await turns.evaluatePassOutcome(taskId, walledOn("seven_day_opus"));

    // `model` is the tier that actually ran — what this run's spend must be
    // read against — so the requested tier needs its own column to survive.
    expect(run().degradedFrom).toBe("heavy");
    expect(run().model).toBe("standard");
  });

  it("keeps the originally requested tier across a second step down", async () => {
    await turns.evaluatePassOutcome(taskId, walledOn("seven_day_opus"));

    // The retry runs at standard and is walled again, this time on the sonnet
    // allowance. A run that has walked heavy -> standard -> light was still
    // asked for heavy; rewriting `degraded_from` would make it read as a
    // standard run that slipped one rung.
    const retry = retryTask()[0];
    testDb
      .update(schema.tasks)
      .set({ status: "running" })
      .where(eq(schema.tasks.id, retry.id))
      .run();

    const decision = await turns.evaluatePassOutcome(
      retry.id,
      walledOn("seven_day_sonnet")
    );

    expect(decision).toBe("degraded");
    expect(run().model).toBe("light");
    expect(run().degradedFrom).toBe("heavy");
  });

  it("spends no attempt and no interruption", async () => {
    await turns.evaluatePassOutcome(taskId, walledOn("seven_day_opus"));

    // The same two accounting promises the pause makes, for the same reason:
    // the work was never tried, so the attempt budget keeps measuring how hard
    // the work was and the interruption bound keeps measuring restarts.
    expect(run().attempt).toBe(2);
    expect(run().interruptionCount).toBe(1);
  });

  it("tears the refused pass's container down — the retry provisions its own", async () => {
    await turns.evaluatePassOutcome(taskId, walledOn("seven_day_opus"));

    expect(docker.calls).toEqual(["removeContainer"]);
    expect(turns.getActiveTasks().has(taskId)).toBe(false);
    expect(task().status).toBe("failed");
    expect(task().containerId).toBeNull();
    expect(task().containerStatus).toBeNull();
  });

  it("says on the issue which tier it dropped to and that nothing was spent", async () => {
    await turns.evaluatePassOutcome(taskId, walledOn("seven_day_opus"));

    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]).toContain("weekly opus");
    expect(github.comments[0]).toContain("standard");
    expect(github.comments[0]).toContain("neither an attempt nor an interruption");
    expect(systemMessages().join("\n")).toContain("Stepping down from the heavy tier");
  });

  it("steps down on a tier wall that named no reset time", async () => {
    // A degrade waits on no clock, so the missing reset that still blocks a
    // pause cannot block this.
    const decision = await turns.evaluatePassOutcome(
      taskId,
      walledOn("seven_day_opus", null)
    );

    expect(decision).toBe("degraded");
    expect(run().model).toBe("standard");
  });

  it("pauses instead when the wall is account-wide", async () => {
    // The other half of the ticket, asserted here because these two outcomes
    // are decided at the same seam from the same turn: only the window differs.
    const decision = await turns.evaluatePassOutcome(taskId, walledOn("five_hour"));

    expect(decision).toBe("paused");
    expect(run().status).toBe("rate_limited");
    expect(run().model).toBe("heavy");
    expect(run().degradedFrom).toBeNull();
    expect(retryTask()).toHaveLength(0);
  });

  it("pauses at the bottom of the ladder", async () => {
    await bootWith("light");

    const decision = await turns.evaluatePassOutcome(taskId, walledOn("seven_day_opus"));

    expect(decision).toBe("paused");
    expect(run().status).toBe("rate_limited");
    expect(run().model).toBe("light");
    expect(retryTask()).toHaveLength(0);
  });

  it("pauses a run whose tier the ledger does not know", async () => {
    // A deployment pinning a raw model id has no rung to step off, and the
    // fleet may not override that pin by inventing one.
    await bootWith("claude-opus-4-8");

    const decision = await turns.evaluatePassOutcome(taskId, walledOn("seven_day_opus"));

    expect(decision).toBe("paused");
    expect(run().model).toBe("claude-opus-4-8");
    expect(retryTask()).toHaveLength(0);
  });

  it("leaves a healthy pass on its ordinary path", async () => {
    testDb
      .update(schema.tasks)
      .set({ pullRequestNumber: 41 })
      .where(eq(schema.tasks.id, taskId))
      .run();

    const decision = await turns.evaluatePassOutcome(taskId, {
      finalMessage: "Implemented the frobnicator; tests and lint pass.",
      outcome: { kind: "completed" },
    });

    expect(decision).toBe("proceed");
    expect(run().model).toBe("heavy");
    expect(run().degradedFrom).toBeNull();
    expect(retryTask()).toHaveLength(0);
    expect(docker.calls).toEqual([]);
  });
});
