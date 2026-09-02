import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/create-test-db";
import * as schema from "@/db/schema";
import { newId } from "@/lib/ulid";

/**
 * Boot adoption of parked containers (issue #136), through the two things that
 * have to agree for the bug to be fixed: the turn manager's own `activeTasks`
 * map, and the queue's own poll.
 *
 * The incident this reproduces: a run parked `blocked` at 05:21, the app was
 * restarted at 08:04, and the owner's answer — sent twice, once in the UI and
 * once through Discord — sat in `messages` with `deliveredAt` null forever,
 * because the only thing that delivers one iterates a map that only
 * `startTask` ever wrote to.
 *
 * Everything that decides the outcome stays real: the planner, `isParked`, the
 * slot counter and `activeTasks` itself. The daemon is stubbed because the test
 * has to say whether the container survived, and `processQueuedMessages` is
 * stubbed because what is under test is that the queue *reaches* delivery, not
 * what a turn does.
 */

let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const daemon = vi.hoisted(() => ({ says: "present" as "present" | "absent" | "unknown" }));

vi.mock("../../docker/container-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../docker/container-manager")>();
  return {
    ...actual,
    observeContainerAbsent: async () =>
      daemon.says === "unknown" ? null : daemon.says === "absent",
  };
});

vi.mock("../../docker/client", () => ({
  getDocker: () => ({ getContainer: (name: string) => ({ name }) }),
  isDockerAvailable: async () => true,
}));

const github = vi.hoisted(() => ({ comments: [] as Array<{ issueRef: string; body: string }> }));

vi.mock("../../github/issues", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../github/issues")>();
  return {
    ...actual,
    commentOnIssue: async (issueRef: string, body: string) => {
      github.comments.push({ issueRef, body });
    },
  };
});

const turns = vi.hoisted(() => ({ delivered: [] as string[] }));

vi.mock("../turn-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../turn-manager")>();
  return {
    ...actual,
    startTask: () => Promise.resolve(),
    processQueuedMessages: (taskId: string) => {
      turns.delivered.push(taskId);
      return Promise.resolve();
    },
    scanForDevServer: () => Promise.resolve(),
  };
});

vi.mock("../capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../capacity")>();
  return {
    ...actual,
    getCapacity: async () => ({
      slots: 1,
      perAgentMemory: 1200 * 1024 * 1024,
      cpuQuota: 1e9,
    }),
    checkMemoryAdmission: async () => ({ ok: true }),
  };
});

const POLL_MS = 2000;

let active: Map<string, { container: unknown; state: string; kind: string }>;
let queue: typeof import("../queue");
let boot: typeof import("../init");

/** The state the incident left in the database: a blocked run, its parked task
 * with the container it was stopped as, and an answer nobody delivered. */
function seedStrandedBlockedRun(overrides: { containerName?: string | null } = {}) {
  const projectId = newId();
  testDb
    .insert(schema.projects)
    .values({ id: projectId, name: "Moontide", createdAt: new Date() })
    .run();

  const runId = newId();
  testDb
    .insert(schema.runs)
    .values({
      id: runId,
      projectId,
      githubIssue: "lennons301/moontide#62",
      attempt: 1,
      mode: "autonomous",
      status: "blocked",
      budgetUsd: 20,
      blockedQuestion: "Should forceClaimSeat raise capacity, or drop the CHECK?",
      claimedAt: new Date(),
    })
    .run();

  const taskId = newId();
  const containerName =
    overrides.containerName === undefined ? `interlude-task-${taskId}` : overrides.containerName;
  testDb
    .insert(schema.tasks)
    .values({
      id: taskId,
      projectId,
      title: "DB backstops",
      status: "blocked",
      kind: "implement",
      runId,
      githubIssue: "lennons301/moontide#62",
      branch: "agent/issue-62",
      containerName,
      containerId: containerName ? "sha256-62" : null,
      containerStatus: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();

  testDb
    .insert(schema.messages)
    .values({
      id: newId(),
      taskId,
      role: "user",
      content: JSON.stringify({ text: "Option A) — raise the capacity." }),
      createdAt: new Date(),
    })
    .run();

  return { projectId, runId, taskId, containerName };
}

describe("boot adoption of parked containers (#136)", () => {
  beforeEach(async () => {
    testDb = createTestDb().db;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    daemon.says = "present";
    github.comments.length = 0;
    turns.delivered.length = 0;
    vi.resetModules();
    vi.useFakeTimers();
    queue = await import("../queue");
    boot = await import("../init");
    active = (await import("../turn-manager")).getActiveTasks() as typeof active;
    active.clear();
  });

  afterEach(() => {
    queue.stopQueue();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("re-adopts a surviving container and delivers the answer on the next poll", async () => {
    const { taskId } = seedStrandedBlockedRun();

    await boot.adoptParkedContainers();

    expect(active.get(taskId)).toMatchObject({ state: "idle", kind: "implement" });
    // Parked, so it holds no slot — exactly as it held none before the restart.
    expect(queue.occupiedSlots()).toBe(0);

    queue.startQueue();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(turns.delivered).toEqual([taskId]);
  });

  it("interrupts the run when the container is gone, consuming no attempt", async () => {
    const { runId, taskId } = seedStrandedBlockedRun();
    daemon.says = "absent";

    await boot.adoptParkedContainers();

    expect(active.has(taskId)).toBe(false);
    const run = testDb.select().from(schema.runs).where(eq(schema.runs.id, runId)).get();
    expect(run).toMatchObject({ status: "interrupted", attempt: 1, interruptionCount: 1 });
    const task = testDb.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
    expect(task?.status).toBe("failed");
  });

  it("carries the question and the undelivered answer onto the issue", async () => {
    seedStrandedBlockedRun();
    daemon.says = "absent";

    await boot.adoptParkedContainers();

    expect(github.comments).toHaveLength(1);
    expect(github.comments[0].issueRef).toBe("lennons301/moontide#62");
    expect(github.comments[0].body).toContain(
      "Should forceClaimSeat raise capacity, or drop the CHECK?"
    );
    expect(github.comments[0].body).toContain("Option A) — raise the capacity.");
  });

  it("leaves the run blocked when the daemon cannot say", async () => {
    const { runId, taskId } = seedStrandedBlockedRun();
    daemon.says = "unknown";

    await boot.adoptParkedContainers();

    expect(active.has(taskId)).toBe(false);
    const run = testDb.select().from(schema.runs).where(eq(schema.runs.id, runId)).get();
    expect(run?.status).toBe("blocked");
    expect(github.comments).toEqual([]);
  });

  it("is idempotent across repeated boots", async () => {
    const { taskId } = seedStrandedBlockedRun();

    await boot.adoptParkedContainers();
    const adopted = active.get(taskId);
    await boot.adoptParkedContainers();

    expect(active.size).toBe(1);
    expect(active.get(taskId)).toBe(adopted);
  });
});
