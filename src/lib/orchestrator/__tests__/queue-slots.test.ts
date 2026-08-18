import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/create-test-db";
import * as schema from "@/db/schema";
import { newId } from "@/lib/ulid";

/**
 * Slot accounting through the queue's own seam (issue #151): the 2026-08-18
 * wedge was a reservation that outlived its task, so the box read one slot
 * busy while the DB — and Docker — said idle, and nothing dispatched again
 * until a restart.
 *
 * The turn manager is stubbed at the two promises the queue drives (`startTask`
 * and `processQueuedMessages`) so a *hung* one can be simulated exactly as it
 * happened: the promise never settles, which is what the `.finally()` release
 * depended on. `isParked` and the local capacity provider stay real — they are
 * the other half of the count under test.
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
      return turns.hang ? new Promise<void>(() => {}) : Promise.resolve();
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
  });

  it("dispatches a queued task after a hung delivery promise's task completes", async () => {
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

    // The follow-up was picked up for delivery, and its promise never settles —
    // the post-turn `createDraftPr` that hung on 2026-08-18.
    expect(turns.delivered).toEqual([chatting]);
    expect(queue.occupiedSlots()).toBe(1);

    // The owner completes the session while that turn's promise is still in
    // flight: the container goes, the task is terminal, the reservation stays.
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
});
