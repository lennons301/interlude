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
 * Issue #159 is the same wedge from the other side — a *session entry* that
 * outlived its task, which on a one-slot box held all pickup until a restart.
 *
 * The turn manager is stubbed at the two promises the queue drives (`startTask`
 * and `processQueuedMessages`) because the hang has to be reproduced, and only
 * a stub can hang on demand. The delivery stub hangs on a *real* GitHub request
 * through the repo's own client — the post-turn `createDraftPr` that never
 * returned — with the request bound set beyond the test's horizon, so what is
 * under test is the slot, not the bound. Everything that decides the count
 * stays real: `isParked`, `pruneTerminalActiveTasks`, the local capacity
 * provider, and `activeTasks` itself — the tests drive the turn manager's own
 * map rather than a stand-in, so the prune under test is the one production
 * runs.
 */

let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const turns = vi.hoisted(() => ({
  dispatched: [] as string[],
  delivered: [] as string[],
  /** Resolve/never-resolve control for the stubbed promises */
  hang: true,
}));

/** What the daemon says when the queue asks whether a container still exists —
 * the three outcomes `observeContainerAbsent` reports. `"unknown"` is the
 * daemon not answering (an error or a timeout, folded to null by the probe's
 * own bound), and it must decide nothing either way. */
const daemon = vi.hoisted(() => ({
  says: "present" as "present" | "absent" | "unknown",
  asked: [] as string[],
}));

vi.mock("../../docker/container-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../docker/container-manager")>();
  return {
    ...actual,
    observeContainerAbsent: async (name: string) => {
      daemon.asked.push(name);
      if (daemon.says === "unknown") return null;
      return daemon.says === "absent";
    },
  };
});

vi.mock("../turn-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../turn-manager")>();
  return {
    ...actual,
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
  active.delete(taskId);
}

/** The turn manager's own activeTasks map, ours to drive. Process-wide since
 * #159, so it survives `vi.resetModules()` and each test must start it empty. */
let active: Map<string, { container: unknown; state: string; kind: string }>;

describe("queue slot accounting", () => {
  let queue: Queue;

  beforeEach(async () => {
    testDb = createTestDb().db;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {}))
    );
    turns.dispatched.length = 0;
    turns.delivered.length = 0;
    turns.hang = true;
    daemon.says = "present";
    daemon.asked.length = 0;
    vi.resetModules();
    vi.useFakeTimers();
    queue = await import("../queue");
    active = (await import("../turn-manager")).getActiveTasks() as typeof active;
    active.clear();
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
    active.set(chatting, {
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

  it("frees the slot when a session entry outlives its completed task", async () => {
    const projectId = seedProject();
    const chatting = seedTask(projectId, {
      status: "running",
      containerStatus: "idle",
    });
    active.set(chatting, {
      container: {},
      state: "idle",
      kind: "interactive",
    });

    queue.startQueue();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    // An idle interactive session legitimately holds its slot — its dev server
    // and the owner's next message are live concerns.
    expect(queue.occupiedSlots()).toBe(1);

    // The owner clicks Complete. The task row goes terminal and the container
    // goes, but the session entry is left behind — what #159's split module
    // graphs did on *every* UI close, and what any terminal path that failed to
    // hand its entry back would do. The entry claims an agent process that
    // cannot exist.
    testDb
      .update(schema.tasks)
      .set({ status: "completed", containerStatus: null, containerId: null })
      .where(eq(schema.tasks.id, chatting))
      .run();

    // Not counted the moment the row says finished — no Docker call needed, and
    // no waiting for a poll.
    expect(queue.occupiedSlots()).toBe(0);

    const next = seedTask(projectId, { title: "The next task" });
    await vi.advanceTimersByTimeAsync(POLL_MS);

    // The wedge is over: queued work dispatches instead of waiting for a restart.
    expect(turns.dispatched).toEqual([next]);
    // ...and the stranded entry is gone, so it cannot be a delivery target or a
    // port-scan target either.
    expect(active.has(chatting)).toBe(false);
  });

  it("keeps a parked autonomous pass's entry, which is still live work", async () => {
    const projectId = seedProject();
    const pass = seedTask(projectId, {
      title: "Implement #159",
      kind: "implement",
      status: "running",
      containerStatus: "idle",
    });
    // Parked awaiting its review verdict: container stopped to free memory
    // (#93), entry kept so a fix-up turn lands in the same attempt.
    active.set(pass, { container: {}, state: "idle", kind: "implement" });

    queue.startQueue();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    // It holds no slot (parked)...
    expect(queue.occupiedSlots()).toBe(0);
    // ...but its task is `running`, so the prune must not touch it: dropping it
    // would strand the attempt with a container nothing can deliver into.
    expect(active.has(pass)).toBe(true);
  });

  /** The reconciliation runs every RECONCILE_EVERY_POLLS cycles, not every one. */
  const RECONCILE_MS = 16 * POLL_MS;

  it("releases a slot the daemon says has no container behind it", async () => {
    const projectId = seedProject();
    // A session the DB still calls live — nothing has marked it terminal, so
    // layer 1 cannot help. Its container died out of band.
    const orphaned = seedTask(projectId, {
      status: "running",
      containerStatus: "running",
      containerId: "abc123",
    });
    active.set(orphaned, {
      container: { name: "interlude-task-orphaned" },
      state: "running",
      kind: "interactive",
    });
    const waiting = seedTask(projectId, { title: "The starved task" });

    queue.startQueue();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    // Pickup is blocked, and on the numbers alone it looks legitimate.
    expect(queue.occupiedSlots()).toBe(1);
    expect(turns.dispatched).toEqual([]);

    daemon.says = "absent";
    await vi.advanceTimersByTimeAsync(RECONCILE_MS);

    expect(daemon.asked).toContain("interlude-task-orphaned");
    expect(active.has(orphaned)).toBe(false);
    // The freed slot goes straight to the work that was starving — which is why
    // it reads occupied again, this time by something real.
    expect(turns.dispatched).toEqual([waiting]);
    // And the task is recorded failed rather than left `running` with no
    // container: a row the dashboard still counts and the queue does not is the
    // disagreement this ticket was about.
    expect(
      testDb.select().from(schema.tasks).where(eq(schema.tasks.id, orphaned)).get()
    ).toMatchObject({ status: "failed", containerStatus: null, containerId: null });
  });

  it("leaves a run-owned pass to its own recovery paths", async () => {
    const projectId = seedProject();
    const runId = newId();
    testDb
      .insert(schema.runs)
      .values({
        id: runId,
        projectId,
        githubIssue: "lennons301/moontide#33",
        status: "implementing",
        mode: "autonomous",
        attempt: 1,
        budgetUsd: 20,
        claimedAt: new Date(),
      })
      .run();
    const pass = seedTask(projectId, {
      title: "Implement #33",
      kind: "implement",
      status: "running",
      containerStatus: "running",
      runId,
    });
    active.set(pass, {
      container: { name: "interlude-task-pass" },
      state: "running",
      kind: "implement",
    });
    // Something has to be waiting on the slot: with nothing queued there is no
    // wedge to clear, and the reconciliation never runs.
    seedTask(projectId, { title: "The waiting task" });

    queue.startQueue();
    daemon.says = "absent";
    await vi.advanceTimersByTimeAsync(RECONCILE_MS);

    // Failing it from here would burn one of MAX_ATTEMPTS on work that did not
    // fail, or strand the run mid-status. The #95 reaper, the #97 interruption
    // bound and the #106 boot sweep account for this properly, so the queue
    // says what it saw and leaves the entry alone.
    expect(daemon.asked).toContain("interlude-task-pass");
    expect(active.has(pass)).toBe(true);
    expect(
      testDb.select().from(schema.tasks).where(eq(schema.tasks.id, pass)).get()?.status
    ).toBe("running");
  });

  it("holds the slot when the daemon cannot answer", async () => {
    const projectId = seedProject();
    const live = seedTask(projectId, {
      status: "running",
      containerStatus: "running",
      containerId: "abc123",
    });
    active.set(live, {
      container: { name: "interlude-task-live" },
      state: "running",
      kind: "interactive",
    });
    seedTask(projectId, { title: "The next task" });

    queue.startQueue();

    // An unhealthy daemon may not manufacture an absence: freeing a slot out
    // from under live work is worse than the wedge it would fix, and a daemon
    // that cannot answer is the likeliest companion of a box under pressure.
    daemon.says = "unknown";
    await vi.advanceTimersByTimeAsync(RECONCILE_MS);
    expect(daemon.asked).toContain("interlude-task-live");
    expect(active.has(live)).toBe(true);
    expect(turns.dispatched).toEqual([]);

    // Nor may a daemon that positively confirms the container.
    daemon.says = "present";
    await vi.advanceTimersByTimeAsync(RECONCILE_MS);
    expect(active.has(live)).toBe(true);
    expect(turns.dispatched).toEqual([]);
  });

  it("never asks the daemon about a parked pass, which holds no slot", async () => {
    const projectId = seedProject();
    const pass = seedTask(projectId, {
      title: "Implement #159",
      kind: "implement",
      status: "running",
      containerStatus: "idle",
    });
    // Parked containers are `docker stop`ped since #93 — present, but only an
    // existence check would say so. There is no slot to reclaim either way.
    active.set(pass, {
      container: { name: "interlude-task-parked" },
      state: "idle",
      kind: "implement",
    });

    queue.startQueue();
    daemon.says = "absent";
    await vi.advanceTimersByTimeAsync(RECONCILE_MS);

    expect(daemon.asked).not.toContain("interlude-task-parked");
    expect(active.has(pass)).toBe(true);
  });

  it("holds a provisioning pickup's reservation however long it takes", async () => {
    const projectId = seedProject();
    const provisioning = seedTask(projectId, { title: "The slow pickup" });

    queue.startQueue();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    // Picked up, and still inside `createWorkspaceContainer` — which runs
    // `ensureImage`, so a cold agent-image build legitimately has no container
    // to show for many minutes. The task is `running` (startTask writes that
    // before provisioning) with no container id: indistinguishable, from here,
    // from a provision that will never finish.
    expect(turns.dispatched).toEqual([provisioning]);
    testDb
      .update(schema.tasks)
      .set({ status: "running", containerStatus: "setup" })
      .where(eq(schema.tasks.id, provisioning))
      .run();
    seedTask(projectId, { title: "The waiting task" });

    // So the reservation is never released on age alone. Letting it go and
    // admitting the next pickup would put two agent containers on a one-slot
    // box the moment the slow provision landed, with nothing re-checking memory
    // — the overcommit shape behind the 2026-08-19 host OOM. A phantom
    // reservation is left to the watchdog's phantom-slot card, whose remedy is
    // a human-gated restart.
    await vi.advanceTimersByTimeAsync(40 * 60_000);
    expect(queue.occupiedSlots()).toBe(1);
    expect(turns.dispatched).toEqual([provisioning]);
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
    active.set(pass, { container: {}, state: "setup", kind: "implement" });
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
    active.set(pass, { container: {}, state: "idle", kind: "implement" });
    expect(queue.occupiedSlots()).toBe(0);

    const review = seedTask(projectId, { title: "Review PR #157", kind: "review" });
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(turns.dispatched).toEqual([pass, review]);
  });
});
