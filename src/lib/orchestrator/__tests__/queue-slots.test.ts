import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/create-test-db";
import * as schema from "@/db/schema";
import { newId } from "@/lib/ulid";
import { createOctokit } from "@/lib/github/client";

/**
 * Slot accounting through the queue's own seam (issue #151): the 2026-08-18
 * wedge was a reservation that outlived its task, so the box read one slot
 * busy while the DB — and Docker — said idle, and nothing dispatched again
 * until a restart.
 *
 * The turn manager is stubbed at the two promises the queue drives (`startTask`
 * and `processQueuedMessages`) because the hang has to be reproduced, and only
 * a stub can hang on demand. The delivery stub hangs on a *real* GitHub request
 * through the repo's own client — the post-turn `createDraftPr` that never
 * returned — with the request bound set beyond the test's horizon, so what is
 * under test is the slot, not the bound. `isParked` and the local capacity
 * provider stay real: they are the other half of the count.
 */

let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const turns = vi.hoisted(() => ({
  /** The turn manager's activeTasks map, ours to drive */
  active: new Map<string, { container: unknown; state: string; kind: string }>(),
  dispatched: [] as string[],
  delivered: [] as string[],
  /** Resolve/never-resolve control for the stubbed promises */
  hang: true,
}));

vi.mock("../turn-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../turn-manager")>();
  return {
    ...actual,
    getActiveTasks: () => turns.active,
    startTask: (taskId: string) => {
      turns.dispatched.push(taskId);
      return turns.hang ? new Promise<void>(() => {}) : Promise.resolve();
    },
    processQueuedMessages: (taskId: string) => {
      turns.delivered.push(taskId);
      return turns.hang ? hungPostTurnGitHubCall() : Promise.resolve();
    },
    scanForDevServer: () => Promise.resolve(),
  };
});

vi.mock("../capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../capacity")>();
  return {
    ...actual,
    // One slot, as CAPACITY_SLOTS=1 in production since the #93 OOM — which is
    // what made a single phantom occupant fatal to the whole box.
    getCapacity: async () => ({
      slots: 1,
      perAgentMemory: 1200 * 1024 * 1024,
      cpuQuota: 1e9,
    }),
    checkMemoryAdmission: async () => ({ ok: true }),
  };
});

type Queue = typeof import("../queue");

/**
 * What `runPostTurnCommitAndPush` does after a turn — open the task's draft PR —
 * against a GitHub that never answers. A real client, so the promise that hangs
 * is a real outbound call rather than a stand-in; the bound is set past the
 * test's horizon so the call is still outstanding at every assertion.
 */
function hungPostTurnGitHubCall(): Promise<void> {
  return createOctokit("installation-token", 10 * 60_000).rest.pulls.create({
    owner: "lennons301",
    repo: "moontide",
    title: "Draft",
    head: "agent/01M09TACWZ31M9KQ5KZQER8V6V",
    base: "main",
  }) as unknown as Promise<void>;
}

const POLL_MS = 2000;

function seedProject(): string {
  const id = newId();
  testDb
    .insert(schema.projects)
    .values({ id, name: "Moontide", createdAt: new Date() })
    .run();
  return id;
}

function seedTask(
  projectId: string,
  overrides: Partial<typeof schema.tasks.$inferInsert> = {}
): string {
  const id = newId();
  testDb
    .insert(schema.tasks)
    .values({
      id,
      projectId,
      title: "A task",
      status: "queued",
      kind: "interactive",
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    })
    .run();
  return id;
}

function seedUndeliveredMessage(taskId: string): void {
  testDb
    .insert(schema.messages)
    .values({
      id: newId(),
      taskId,
      role: "user",
      content: "another turn please",
      createdAt: new Date(),
    })
    .run();
}

/** What `completeTask` leaves behind: a terminal task row and no activeTasks
 * entry — while a still-running promise holds its reservation. */
function completeTask(taskId: string): void {
  testDb
    .update(schema.tasks)
    .set({ status: "completed", containerStatus: null })
    .where(eq(schema.tasks.id, taskId))
    .run();
  turns.active.delete(taskId);
}

describe("queue slot accounting", () => {
  let queue: Queue;

  beforeEach(async () => {
    testDb = createTestDb().db;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {}))
    );
    turns.active.clear();
    turns.dispatched.length = 0;
    turns.delivered.length = 0;
    turns.hang = true;
    vi.resetModules();
    vi.useFakeTimers();
    queue = await import("../queue");
  });

  afterEach(() => {
    queue.stopQueue();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("frees the slot when a hung post-turn GitHub call outlives its task", async () => {
    const projectId = seedProject();
    const chatting = seedTask(projectId, {
      status: "running",
      containerStatus: "idle",
    });
    turns.active.set(chatting, {
      container: {},
      state: "idle",
      kind: "interactive",
    });
    seedUndeliveredMessage(chatting);

    queue.startQueue();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    // The follow-up was picked up for delivery, and the draft-PR call it ends on
    // never answers — so the promise driving that delivery never settles, and
    // the bookkeeping it holds is never handed back by `.finally()`.
    expect(turns.delivered).toEqual([chatting]);
    // One slot occupied, by the live container — not by the delivery.
    expect(queue.occupiedSlots()).toBe(1);

    // The owner completes the session while that call is still outstanding: the
    // container goes and the task is terminal, so the box is genuinely idle.
    completeTask(chatting);
    expect(queue.occupiedSlots()).toBe(0);

    const next = seedTask(projectId, { title: "The next task" });
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(turns.dispatched).toEqual([next]);
  });

  it("dispatches a queued task after a hung pickup's task is cancelled", async () => {
    const projectId = seedProject();
    const wedged = seedTask(projectId, { title: "The wedged pickup" });

    queue.startQueue();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    // Picked up, and provisioning hung before the container ever registered —
    // so this reservation does stand in for a slot while the task is live.
    expect(turns.dispatched).toEqual([wedged]);
    expect(queue.occupiedSlots()).toBe(1);

    testDb
      .update(schema.tasks)
      .set({ status: "cancelled", containerStatus: null })
      .where(eq(schema.tasks.id, wedged))
      .run();
    expect(queue.occupiedSlots()).toBe(0);

    const next = seedTask(projectId, { title: "The next task" });
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(turns.dispatched).toEqual([wedged, next]);
  });

  it("hands the slot from a pickup to the container it registers, and back when that parks", async () => {
    const projectId = seedProject();
    const pass = seedTask(projectId, { title: "Implement #151", kind: "implement" });

    queue.startQueue();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(turns.dispatched).toEqual([pass]);
    expect(queue.occupiedSlots()).toBe(1);

    // The container comes up: the entry is the occupant from here on, and the
    // pickup that stood in for it must not be counted a second time — even
    // though its promise is still running.
    turns.active.set(pass, { container: {}, state: "setup", kind: "implement" });
    testDb
      .update(schema.tasks)
      .set({ status: "running", containerStatus: "setup" })
      .where(eq(schema.tasks.id, pass))
      .run();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(queue.occupiedSlots()).toBe(1);

    // The pass ends its turn and parks awaiting review (#93): it runs no agent
    // process, so the slot is free for the next ticket — which is only true if
    // the pickup let go of its reservation when the container registered.
    turns.active.set(pass, { container: {}, state: "idle", kind: "implement" });
    expect(queue.occupiedSlots()).toBe(0);

    const review = seedTask(projectId, { title: "Review PR #157", kind: "review" });
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(turns.dispatched).toEqual([pass, review]);
  });
});
