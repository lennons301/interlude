import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb } from "@/test/create-test-db";
import * as schema from "@/db/schema";
import { newId } from "@/lib/ulid";

/**
 * The pickup half of the crossing (issue #173), through the queue's own loop:
 * an attended session the money guards refuse must not start, must be told
 * why, and — the part that is easy to get wrong — must not hold the work
 * behind it.
 *
 * Interactive tasks sort first in the pickup order (issue #15), so a session
 * waiting on one press sits at the head of the queue. Left there it would stop
 * the review passes and resumes behind it from ever starting: work the fleet
 * has already paid for, held up by work it has not yet been authorised to pay
 * for. That is the wedge shape this platform keeps meeting, so it has a test.
 *
 * The turn manager is stubbed at `startTask` (dispatch is what is being
 * observed, not what a pass then does) and Docker at the two calls the loop
 * makes. Everything that decides is real: the lane file, the quota row, the
 * settings row, the ledger and the pure crossing.
 */

let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const turns = vi.hoisted(() => ({ dispatched: [] as string[] }));

vi.mock("../turn-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../turn-manager")>();
  return {
    ...actual,
    startTask: (taskId: string) => {
      turns.dispatched.push(taskId);
      // Never settles: a dispatched task holds its slot, exactly as a real
      // pass does while its container runs.
      return new Promise<void>(() => {});
    },
    processQueuedMessages: () => Promise.resolve(),
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

import { resetConfig } from "@/lib/config";
import { resetLaneCatalog } from "@/lib/lanes/catalog";
import { recordQuotaObservation } from "@/lib/quota/quota-store";
import { recordMeteredSpend } from "../spend";
import { setMeteredSpendConfirmed, updateSettingsOverrides } from "@/lib/settings";

type Queue = typeof import("../queue");

const POLL_MS = 2000;
const savedEnv = { ...process.env };

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

/** The subscription lane refusing work, with a stated reset — what an
 * interactive session overflows off (and what #168 parks an autonomous run
 * on). Keyed to that lane, because a quota row belongs to one (issue #175). */
function recordWall(): void {
  recordQuotaObservation("claude-subscription", {
    status: "rejected",
    rateLimitType: "five_hour",
    utilization: null,
    resetsAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
    overageStatus: null,
    overageResetsAt: null,
    isUsingOverage: false,
    overageInUse: null,
    observedAt: new Date(),
  });
}

/** Every system note on a task's feed, in order. */
function notes(taskId: string): string[] {
  return testDb
    .select()
    .from(schema.messages)
    .all()
    .filter((m) => m.taskId === taskId && m.role === "system")
    .map((m) => {
      try {
        return String(JSON.parse(m.content).text ?? "");
      } catch {
        return m.content;
      }
    });
}

describe("attended pickup under the money guards", () => {
  let queue: Queue;

  beforeEach(async () => {
    testDb = createTestDb().db;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    turns.dispatched.length = 0;
    // A subscription primary with one paid lane available to overflow onto.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test";
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.AGENT_LANE;
    delete process.env.METERED_DAILY_CAP_USD;
    resetConfig();
    resetLaneCatalog();
    vi.resetModules();
    vi.useFakeTimers();
    queue = await import("../queue");
    (await import("../turn-manager")).getActiveTasks().clear();
  });

  afterEach(() => {
    queue.stopQueue();
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.env = { ...savedEnv };
    resetConfig();
    resetLaneCatalog();
  });

  it("dispatches an attended session normally while the window is fine", async () => {
    const chat = seedTask(seedProject());

    queue.startQueue();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(turns.dispatched).toEqual([chat]);
    expect(notes(chat)).toEqual([]);
  });

  it("holds it for the day's first confirmation, and says so on its feed", async () => {
    const chat = seedTask(seedProject());
    recordWall();

    queue.startQueue();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(turns.dispatched).toEqual([]);
    // The task is not failed — a press is a press away.
    const row = testDb.select().from(schema.tasks).all()[0];
    expect(row.status).toBe("queued");
    const [note] = notes(chat);
    expect(note).toContain("Confirm real-money spend");
    expect(note).toContain("OpenRouter");
  });

  it("writes that note once, however long the press takes", async () => {
    const chat = seedTask(seedProject());
    recordWall();

    queue.startQueue();
    await vi.advanceTimersByTimeAsync(POLL_MS * 10);

    expect(notes(chat)).toHaveLength(1);
  });

  it("starts it on the poll after the confirmation, on the paid lane", async () => {
    const chat = seedTask(seedProject());
    recordWall();

    queue.startQueue();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(turns.dispatched).toEqual([]);

    // The press the session asked for — the same fleet-level fact #174 keeps.
    setMeteredSpendConfirmed(true);
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(turns.dispatched).toEqual([chat]);
  });

  it("tells it that it is capped, and does not start it", async () => {
    const chat = seedTask(seedProject());
    recordWall();
    setMeteredSpendConfirmed(true);
    updateSettingsOverrides({ meteredDailyCapUsd: "5" });
    recordMeteredSpend(0, 5.5);

    queue.startQueue();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(turns.dispatched).toEqual([]);
    expect(notes(chat)[0]).toContain("Capped");
    expect(notes(chat)[0]).toContain("$5.00");
  });

  it("names the missing variable when there is nowhere to overflow", async () => {
    delete process.env.OPENROUTER_API_KEY;
    resetConfig();
    const chat = seedTask(seedProject());
    recordWall();
    setMeteredSpendConfirmed(true);

    queue.startQueue();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(turns.dispatched).toEqual([]);
    expect(notes(chat)[0]).toContain("ANTHROPIC_API_KEY");
    expect(notes(chat)[0]).toContain("OPENROUTER_API_KEY");
  });

  it("never holds the work behind it — a review pass starts instead", async () => {
    const projectId = seedProject();
    const chat = seedTask(projectId, { title: "A held session" });
    const review = seedTask(projectId, { title: "A review pass", kind: "review" });
    recordWall();

    queue.startQueue();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    // Interactive sorts first, so without the skip this poll would have
    // started nothing at all and the review would wait out the whole window.
    expect(turns.dispatched).toEqual([review]);
    expect(notes(chat)[0]).toContain("Confirm real-money spend");
  });

  it("does not hold an autonomous pass — it runs and #168 parks its run", async () => {
    const projectId = seedProject();
    const implement = seedTask(projectId, { kind: "implement" });
    recordWall();

    queue.startQueue();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(turns.dispatched).toEqual([implement]);
    expect(notes(implement)).toEqual([]);
  });
});
