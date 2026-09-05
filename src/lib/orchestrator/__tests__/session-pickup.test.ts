import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb } from "@/test/create-test-db";
import * as schema from "@/db/schema";
import { newId } from "@/lib/ulid";
import { HARNESS_ADAPTER_DESCRIPTORS } from "@/lib/harness/descriptors";
import { parseLaneConfig, type LaneCatalog } from "@/lib/lanes/lane-config";
import { FAKE_NO_SKILLS_HARNESS_ID, fakeNoSkillsDescriptor } from "@/test/fake-harness";

/**
 * The pickup half of issue #218, through the queue's own loop: a generation
 * session no lane can host must not start, must be told why, and — the part
 * this fleet keeps having to re-learn — must not hold the work behind it.
 *
 * Unlike #173's money holds, this hold is the *session's*, not the fleet's:
 * an ordinary chat behind it runs on a lane that cannot invoke a skill
 * perfectly well. So the loop steps over only the sessions, and the chats and
 * autonomous passes behind them are dispatched on the same poll.
 *
 * The turn manager is stubbed at `startTask` (dispatch is what is observed)
 * and the lane file is a two-lane catalog: a lane on a harness that does not
 * expand a user-invoked skill, made primary, beside the Claude subscription.
 * Everything that decides — the settings row, the ledger, the pure crossing —
 * is real.
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
      slots: 2,
      perAgentMemory: 1200 * 1024 * 1024,
      cpuQuota: 1e9,
    }),
    checkMemoryAdmission: async () => ({ ok: true }),
  };
});

const NO_SKILLS = FAKE_NO_SKILLS_HARNESS_ID;

function catalog(): LaneCatalog {
  const parsed = parseLaneConfig(
    `
primary:
  - other-sub
  - claude-subscription
lanes:
  - id: other-sub
    label: Other harness
    adapter: ${NO_SKILLS}
    billing: subscription
    auth:
      OTHER_TOKEN: OTHER_TOKEN
    models:
      heavy: other-big
      standard: other-mid
      light: other-small
  - id: claude-subscription
    label: Claude subscription
    adapter: claude-code
    billing: subscription
    auth:
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_CODE_OAUTH_TOKEN
    models:
      heavy: opus
      standard: sonnet
      light: haiku
`,
    [...HARNESS_ADAPTER_DESCRIPTORS, fakeNoSkillsDescriptor]
  );
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.catalog;
}

vi.mock("../../lanes/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lanes/catalog")>();
  return {
    ...actual,
    getLaneCatalog: () => ({ ok: true, catalog: catalog() }),
  };
});

import { resetConfig } from "@/lib/config";
import { recordQuotaObservation } from "@/lib/quota/quota-store";

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

function status(taskId: string): string {
  return testDb.select().from(schema.tasks).all().find((t) => t.id === taskId)!.status;
}

describe("picking up a generation session no lane can host (issue #218)", () => {
  let queue: Queue;

  beforeEach(async () => {
    testDb = createTestDb().db;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    turns.dispatched.length = 0;
    // The other harness's lane is primary and available; the one lane that
    // could host a session has no credential.
    process.env.OTHER_TOKEN = "t";
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.AGENT_LANE;
    resetConfig();
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
  });

  it("holds the session, queued, and says why on its feed", async () => {
    const session = seedTask(seedProject(), { sessionSkill: "grill-me" });

    queue.startQueue();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(turns.dispatched).toEqual([]);
    expect(status(session)).toBe("queued");
    const [note] = notes(session);
    expect(note).toContain("A grill-me session needs a lane whose harness can invoke skills");
    expect(note).toContain(`other-sub runs ${NO_SKILLS}, which cannot invoke a skill`);
    expect(note).toContain("claude-subscription needs CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("writes that note once, however long the fix takes", async () => {
    const session = seedTask(seedProject(), { sessionSkill: "grill-me" });

    queue.startQueue();
    await vi.advanceTimersByTimeAsync(POLL_MS * 10);

    expect(notes(session)).toHaveLength(1);
  });

  it("steps over only the sessions — the chat behind them starts on the lane in force", async () => {
    const projectId = seedProject();
    const first = seedTask(projectId, { title: "A held session", sessionSkill: "grill-me" });
    const second = seedTask(projectId, { title: "Another", sessionSkill: "to-spec" });
    const chat = seedTask(projectId, { title: "An ordinary chat" });

    queue.startQueue();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    // Interactive sorts first, so with the whole kind skipped (#173's width)
    // the chat would have waited on a fix it does not need. Only the head is
    // told: the second session gets its line when it reaches the head.
    expect(turns.dispatched).toEqual([chat]);
    expect(notes(first)).toHaveLength(1);
    expect(notes(second)).toEqual([]);
    expect(notes(chat)).toEqual([]);
  });

  it("never holds an autonomous pass behind it", async () => {
    const projectId = seedProject();
    const session = seedTask(projectId, { sessionSkill: "to-tickets" });
    const review = seedTask(projectId, { title: "A review pass", kind: "review" });

    queue.startQueue();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(turns.dispatched).toEqual([review]);
    expect(status(session)).toBe("queued");
  });

  it("holds the session on the clock when the one lane that can host it is walled — and only the sessions", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth";
    resetConfig();
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
    const projectId = seedProject();
    const session = seedTask(projectId, { sessionSkill: "grill-me" });
    const chat = seedTask(projectId, { title: "An ordinary chat" });

    queue.startQueue();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    // The wall is the Claude lane's, not the lane in force's, so the chat is
    // not held by it — it runs on the lane in force — while the session waits
    // for the window it needs.
    expect(turns.dispatched).toEqual([chat]);
    expect(status(session)).toBe("queued");
    expect(notes(session)[0]).toContain("claude-subscription's window is exhausted");
    expect(notes(session)[0]).toContain("starts when a window that can host it resets");
  });

  it("dispatches the session once a lane that can host it is available", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth";
    resetConfig();
    const session = seedTask(seedProject(), { sessionSkill: "grill-me" });

    queue.startQueue();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    // Routed off the lane in force onto the one that can invoke the skill;
    // nothing to say on the feed, since nothing costs money.
    expect(turns.dispatched).toEqual([session]);
    expect(notes(session)).toEqual([]);
  });
});
