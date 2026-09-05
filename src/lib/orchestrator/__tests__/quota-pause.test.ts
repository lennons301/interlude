import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/create-test-db";
import * as schema from "@/db/schema";
import { newId } from "@/lib/ulid";

/**
 * What a quota wall does to the run ledger (issue #168), driven through the
 * real pass-completion seam over a real (in-memory, migrated) database.
 *
 * The reducer's table tests say what is *decided*; these say what is *written*,
 * which is where the ticket's two accounting promises actually live: a paused
 * run must not spend an attempt, and must not spend an interruption. Neither is
 * observable from the reducer — it emits one action and writes nothing — so
 * asserting them anywhere else would be asserting an intention.
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
  /** Container-manager calls in order — the teardown assertion reads this. */
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

/** The turn result the adapter hands back at a wall (issue #214): the CLI's
 * `subtype: "success"`-and-all exit, already read by the adapter into the
 * fleet's own word for it. The bytes-to-outcome half is pinned under the
 * adapter (`claude-code-rate-limit-fixture.test.ts`). */
const WALLED_TURN = {
  finalMessage: "You've hit your session limit · resets 2:02am (Europe/London)",
  outcome: {
    kind: "refused" as const,
    refusal: { kind: "quota" as const, resumeAfter: RESUME_AFTER, limitType: "five_hour" },
  },
};

let runId: string;
let taskId: string;

/** An implement pass mid-attempt: attempt 2 of 3, one interruption already on
 * the ledger, so both counters would be visibly wrong if the pause touched them. */
function seedImplementPass(): void {
  const projectId = newId();
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

describe("an implement pass refused by the account's quota (issue #168)", () => {
  let turns: TurnManager;

  beforeEach(async () => {
    testDb = createTestDb().db;
    docker.calls.length = 0;
    github.comments.length = 0;
    vi.resetModules();
    turns = await import("../turn-manager");
    turns.getActiveTasks().clear();
    seedImplementPass();
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parks the run on the window's reset rather than failing it", async () => {
    // Note the seeded pass left no PR — a wall on the initial turn cannot have
    // — which is precisely the shape that used to fall into #106's empty-pass
    // path and spend a strike.
    const decision = await turns.evaluatePassOutcome(taskId, WALLED_TURN);

    expect(decision).toBe("paused");
    expect(run().status).toBe("rate_limited");
    expect(run().resumeAfter).toEqual(RESUME_AFTER);
    // Not finished — it is waiting. A finishedAt here would put the run in the
    // recent ledger as a completed piece of work.
    expect(run().finishedAt).toBeNull();
    expect(run().failureReason).toBeNull();
  });

  it("spends no attempt and no interruption", async () => {
    await turns.evaluatePassOutcome(taskId, WALLED_TURN);

    // The ticket's two accounting promises: the attempt budget keeps measuring
    // how hard the work was, and the interruption bound keeps measuring
    // orchestrator restarts. A wall is neither.
    expect(run().attempt).toBe(2);
    expect(run().interruptionCount).toBe(1);
  });

  it("tears the container down instead of parking it", async () => {
    await turns.evaluatePassOutcome(taskId, WALLED_TURN);

    // A parked container holds ~2 GiB of host memory while holding no slot —
    // the 2026-08-04 wedge — and a five-hour window is far too long to hold one
    // for. `stopContainer` (what a blocked run gets) would be that mistake.
    expect(docker.calls).toEqual(["removeContainer"]);
    expect(turns.getActiveTasks().has(taskId)).toBe(false);
    expect(task().containerId).toBeNull();
    expect(task().containerStatus).toBeNull();
  });

  it("ends the pass's task so it holds no slot while the run waits", async () => {
    await turns.evaluatePassOutcome(taskId, WALLED_TURN);

    expect(task().status).toBe("failed");
  });

  it("says on the issue that nothing was spent, and when it can resume", async () => {
    await turns.evaluatePassOutcome(taskId, WALLED_TURN);

    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]).toContain("5-hour window");
    expect(github.comments[0]).toContain("neither an attempt nor an interruption");
    expect(github.comments[0]).toContain(RESUME_AFTER.toUTCString());
    expect(systemMessages().join("\n")).toContain("Paused on the 5-hour window");
  });

  it("leaves a healthy pass on its ordinary path", async () => {
    // The regression this file could most easily cause: an ordinary finished
    // turn must reach `proceed` untouched, whatever the account's quota says.
    // It needs a PR to be healthy at all — a pass that left none is #106's
    // empty pass, which is exactly the path a walled pass used to fall into.
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
    expect(run().status).toBe("implementing");
    expect(run().resumeAfter).toBeNull();
    expect(docker.calls).toEqual([]);
  });
});
