import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb } from "@/test/create-test-db";
import * as schema from "@/db/schema";
import { newId } from "@/lib/ulid";
import { CHAT_SCAN_EVERY_POLLS, PREVIEW_SCAN_EVERY_POLLS } from "../dev-server-scan";

/**
 * The queue loop's dev-server scans (issue #160, defect 1), driven through the
 * real poll loop on fake timers with the turn manager's own `activeTasks` map.
 * What is under test is *which* sessions the loop looks into and *when*: a
 * live-preview session mid-turn on the short cadence, a plain chat only once
 * idle on the long one, a generation session never — and one scan per task at
 * a time. The scan itself is stubbed: what it does with a port is the turn
 * manager's, tested against `ss` output in the scanner's own suite.
 */

let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const scans = vi.hoisted(() => ({
  calls: [] as { taskId: string; retry: boolean | undefined }[],
  /** Resolve control: while true, a scan never settles. */
  hang: false,
}));

vi.mock("../turn-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../turn-manager")>();
  return {
    ...actual,
    startTask: () => new Promise<void>(() => {}),
    processQueuedMessages: () => Promise.resolve(),
    scanForDevServer: (taskId: string, _c: unknown, opts?: { retry?: boolean }) => {
      scans.calls.push({ taskId, retry: opts?.retry });
      return scans.hang ? new Promise<void>(() => {}) : Promise.resolve();
    },
  };
});

vi.mock("../../docker/container-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../docker/container-manager")>();
  return { ...actual, observeContainerAbsent: async () => false };
});

vi.mock("../capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../capacity")>();
  return {
    ...actual,
    getCapacity: async () => ({ slots: 4, perAgentMemory: 1200 * 1024 * 1024, cpuQuota: 1e9 }),
    checkMemoryAdmission: async () => ({ ok: true }),
  };
});

type Queue = typeof import("../queue");

const POLL_MS = 2000;

function seedProject(): string {
  const id = newId();
  testDb.insert(schema.projects).values({ id, name: "Lemons", createdAt: new Date() }).run();
  return id;
}

function seedRunningTask(
  projectId: string,
  overrides: Partial<typeof schema.tasks.$inferInsert> = {}
): string {
  const id = newId();
  testDb
    .insert(schema.tasks)
    .values({
      id,
      projectId,
      title: "A session",
      status: "running",
      kind: "interactive",
      containerStatus: "running",
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    })
    .run();
  return id;
}

let active: Map<string, { container: unknown; state: string; kind: string }>;

function scannedIds(): string[] {
  return scans.calls.map((c) => c.taskId);
}

describe("queue dev-server scans", () => {
  let queue: Queue;

  beforeEach(async () => {
    testDb = createTestDb().db;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    scans.calls.length = 0;
    scans.hang = false;
    vi.resetModules();
    vi.useFakeTimers();
    queue = await import("../queue");
    active = (await import("../turn-manager")).getActiveTasks() as typeof active;
    active.clear();
  });

  afterEach(() => {
    queue.stopQueue();
    active.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("scans a live-preview session while its turn is running, on the short cadence, without the turn-end retry", async () => {
    const projectId = seedProject();
    const preview = seedRunningTask(projectId, { livePreview: true });
    active.set(preview, { container: {}, state: "running", kind: "interactive" });

    queue.startQueue();
    await vi.advanceTimersByTimeAsync(POLL_MS * (PREVIEW_SCAN_EVERY_POLLS - 1));
    expect(scans.calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(scans.calls).toEqual([{ taskId: preview, retry: false }]);

    // …and again a cadence later, still mid-turn.
    await vi.advanceTimersByTimeAsync(POLL_MS * PREVIEW_SCAN_EVERY_POLLS);
    expect(scannedIds()).toEqual([preview, preview]);
  });

  it("scans a plain chat only once idle, on the long cadence it always had", async () => {
    const projectId = seedProject();
    const chat = seedRunningTask(projectId);
    active.set(chat, { container: {}, state: "running", kind: "interactive" });

    queue.startQueue();
    await vi.advanceTimersByTimeAsync(POLL_MS * CHAT_SCAN_EVERY_POLLS);
    // Mid-turn, a chat is left alone — the turn manager scans it as the turn ends.
    expect(scans.calls).toEqual([]);

    active.get(chat)!.state = "idle";
    await vi.advanceTimersByTimeAsync(POLL_MS * CHAT_SCAN_EVERY_POLLS);
    expect(scans.calls).toEqual([{ taskId: chat, retry: false }]);
  });

  it("never scans a generation session, idle or running", async () => {
    const projectId = seedProject();
    const grill = seedRunningTask(projectId, { sessionSkill: "grill-me" });
    active.set(grill, { container: {}, state: "running", kind: "interactive" });

    queue.startQueue();
    await vi.advanceTimersByTimeAsync(POLL_MS * CHAT_SCAN_EVERY_POLLS);
    active.get(grill)!.state = "idle";
    await vi.advanceTimersByTimeAsync(POLL_MS * CHAT_SCAN_EVERY_POLLS);

    expect(scans.calls).toEqual([]);
  });

  it("never scans a parked autonomous container", async () => {
    const projectId = seedProject();
    const implement = seedRunningTask(projectId, { kind: "implement" });
    active.set(implement, { container: {}, state: "idle", kind: "implement" });

    queue.startQueue();
    await vi.advanceTimersByTimeAsync(POLL_MS * CHAT_SCAN_EVERY_POLLS);

    expect(scans.calls).toEqual([]);
  });

  it("runs one scan per task at a time — a scan the daemon never answers is not stacked behind", async () => {
    const projectId = seedProject();
    const preview = seedRunningTask(projectId, { livePreview: true });
    active.set(preview, { container: {}, state: "running", kind: "interactive" });
    scans.hang = true;

    queue.startQueue();
    await vi.advanceTimersByTimeAsync(POLL_MS * PREVIEW_SCAN_EVERY_POLLS * 4);

    expect(scans.calls).toHaveLength(1);
  });
});
