import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/create-test-db";
import * as schema from "@/db/schema";
import { newId } from "@/lib/ulid";

/**
 * Ending a session from outside the orchestrator's own loop (issue #159).
 *
 * These paths — `completeTask` from the UI's Complete button, `cancelTask` from
 * Cancel — were dead weight before `activeTasks` was shared across module
 * graphs: the route handler's copy of the map was always empty, so every
 * `entry`-conditional branch here was skipped and `completeTask` always took its
 * container-is-gone fallback. Sharing the map made all of them live at once, so
 * what each does when the container is *not* what the entry claims is now
 * load-bearing rather than theoretical.
 *
 * Only outbound I/O is stubbed. The task lifecycle, the DB writes and the
 * ordering between them are the real thing — the ordering is the point.
 */

let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const docker = vi.hoisted(() => ({
  /** What the daemon says about the entry's container. */
  absent: false as boolean | null,
  /** Calls in order, each stamped with the task status at the time — which is
   * how the ordering assertions read. */
  calls: [] as { call: string; statusThen: string | undefined }[],
}));

vi.mock("../../docker/container-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../docker/container-manager")>();
  const record = (call: string) => {
    docker.calls.push({ call, statusThen: currentStatus() });
  };
  return {
    ...actual,
    observeContainerAbsent: async () => docker.absent,
    startContainer: async () => record("startContainer"),
    stopContainer: async () => record("stopContainer"),
    removeContainer: async () => record("removeContainer"),
    execFallbackCommitAndPush: async () => record("push"),
  };
});

vi.mock("../../github/issues", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../github/issues")>();
  return { ...actual, commentOnIssue: async () => undefined };
});

vi.mock("../../discord/notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../discord/notifications")>();
  return {
    ...actual,
    notifyTaskCompleted: async () => null,
    notifyTaskFailed: async () => null,
  };
});

type TurnManager = typeof import("../turn-manager");

function currentStatus(): string | undefined {
  return taskId
    ? testDb.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get()?.status
    : undefined;
}

let taskId: string | null = null;

function seedSession(overrides: Partial<typeof schema.tasks.$inferInsert> = {}): string {
  const projectId = newId();
  testDb
    .insert(schema.projects)
    .values({ id: projectId, name: "Moontide", createdAt: new Date() })
    .run();
  const id = newId();
  testDb
    .insert(schema.tasks)
    .values({
      id,
      projectId,
      title: "hi",
      status: "running",
      kind: "interactive",
      containerStatus: "idle",
      containerId: "abc123",
      containerName: "interlude-task-hi",
      branch: "agent/hi",
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    })
    .run();
  return id;
}

function systemMessages(id: string): string[] {
  return testDb
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.taskId, id))
    .all()
    .map((m) => {
      try {
        return JSON.parse(m.content).text as string;
      } catch {
        return m.content;
      }
    });
}

describe("ending a session from outside the orchestrator loop", () => {
  let turns: TurnManager;

  beforeEach(async () => {
    testDb = createTestDb().db;
    taskId = null;
    docker.absent = false;
    docker.calls.length = 0;
    vi.resetModules();
    turns = await import("../turn-manager");
    turns.getActiveTasks().clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The session entry `startTask` would have left behind. */
  function registerLiveSession(id: string): void {
    turns.getActiveTasks().set(id, {
      container: {
        id: "abc123",
        name: "interlude-task-hi",
        previewSubdomain: "task-hi",
        container: {} as never,
      },
      state: "idle",
      kind: "interactive",
    });
  }

  it("completes a session whose container the daemon has lost", async () => {
    taskId = seedSession();
    registerLiveSession(taskId);
    // The container died out of band — a host OOM kill, a manual `docker rm`.
    docker.absent = true;

    await turns.completeTask(taskId);

    // Completing is what the owner asked for and the branch was pushed after
    // every turn, so there is nothing to fail. Holding a handle is not proof the
    // container is there: without the check the push exec throws and this ends
    // up `failed`, announcing a failure for work that closed normally.
    expect(currentStatus()).toBe("completed");
    expect(systemMessages(taskId)).toContain(
      "Container no longer available — work was pushed after each turn."
    );
    expect(docker.calls.map((c) => c.call)).not.toContain("push");
    expect(turns.getActiveTasks().has(taskId)).toBe(false);
  });

  it("still attempts the final push when the daemon cannot answer", async () => {
    taskId = seedSession();
    registerLiveSession(taskId);
    // Unknown decides nothing — and here "nothing" means the same benefit of
    // the doubt this path has always given: try the push.
    docker.absent = null;

    await turns.completeTask(taskId);

    expect(docker.calls.map((c) => c.call)).toContain("push");
    expect(currentStatus()).toBe("completed");
  });

  it("records a cancellation before it kills the container", async () => {
    taskId = seedSession({ containerStatus: "running" });
    registerLiveSession(taskId);

    await turns.cancelTask(taskId);

    expect(currentStatus()).toBe("cancelled");
    // The ordering is the assertion. Killing the container first ends the turn
    // inside it, and that turn's own error handling then writes `failed` over
    // the owner's cancellation — burning one of MAX_ATTEMPTS on a run whose work
    // did not fail. Writing the status first makes the loser of that race a
    // no-op, because `startTask`'s catch returns early on an already-terminal
    // task.
    expect(docker.calls).toEqual([
      { call: "stopContainer", statusThen: "cancelled" },
      { call: "removeContainer", statusThen: "cancelled" },
    ]);
    expect(turns.getActiveTasks().has(taskId)).toBe(false);
  });
});
