import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/create-test-db";
import * as schema from "@/db/schema";
import { newId } from "@/lib/ulid";
import { readTranscript, saveTranscript } from "@/lib/quota/session-transcript";
import { claudeTranscriptPath } from "@/lib/harness/claude-code";
import { AGENT_WORKDIR } from "@/lib/docker/workdir";
import type { ResolvedLane } from "@/lib/lanes/resolve";

/**
 * The lossless half of a quota pause (issue #169): the conversation is copied
 * out of the container before it is torn down, and put back into the fresh one
 * a resume provisions.
 *
 * Driven through the two real seams — `evaluatePassOutcome` (what a walled
 * turn does) and `restoreSessionTranscript` (what a resumed pass opens with) —
 * over a real migrated database and a real transcript store on disk. Only
 * Docker and GitHub are stubbed, which is what makes the interesting
 * assertions possible: that a transcript that cannot be copied costs the pause
 * nothing, and that a missing one is never resumed against.
 *
 * What is copied, and where it goes back, is the adapter's to say (issue
 * #217): the pass ran on the subscription lane, so the artefact is Claude
 * Code's one transcript file, at the path the adapter derives. The cross-
 * adapter case is `session-carry.test.ts`'s.
 */

let testDb: ReturnType<typeof createTestDb>["db"];
let storeRoot: string;

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const docker = vi.hoisted(() => ({
  calls: [] as string[],
  /** What a `cat` of the transcript inside the container answers with. */
  fileContents: null as Buffer | null,
  /** Files written into the container: path → bytes. */
  written: new Map<string, string>(),
  /** Make a transfer fail, the way a daemon hiccup would. */
  writeFails: false,
  readFails: false,
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
    readContainerFile: async () => {
      docker.calls.push("readContainerFile");
      if (docker.readFails) throw new Error("daemon gone");
      return docker.fileContents;
    },
    writeContainerFile: async (
      _container: unknown,
      filePath: string,
      contents: Buffer | string
    ) => {
      docker.calls.push("writeContainerFile");
      if (docker.writeFails) throw new Error("daemon said no");
      docker.written.set(filePath, contents.toString());
    },
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
const SESSION_ID = "9f4c2a7e-0000-4c1a-9c39-2b2c9f3a55d1";
const RESUME_AFTER = new Date("2026-09-02T17:00:00.000Z");
const TRANSCRIPT = '{"type":"user"}\n{"type":"assistant","text":"halfway"}\n';

/** A turn the account's quota refused, as the adapter reports it (issue
 * #214): the #165 shape — `subtype: "success"` and all — already read into
 * the fleet's own word for it. */
const WALLED_TURN = {
  finalMessage: "You've hit your session limit · resets 6:00pm",
  outcome: {
    kind: "refused" as const,
    refusal: { kind: "quota" as const, resumeAfter: RESUME_AFTER, limitType: "five_hour" },
  },
};

let runId: string;
let taskId: string;
let projectId: string;

function seedImplementPass(): void {
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
      attempt: 1,
      mode: "autonomous",
      status: "implementing",
      budgetUsd: 20,
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
      description: "the implement brief",
      status: "running",
      kind: "implement",
      runId,
      githubIssue: ISSUE_REF,
      branch: "agent/issue-34",
      sessionId: SESSION_ID,
      // The lane the pass ran on names the adapter whose artefacts are copied
      // out (issue #217).
      lane: "claude-subscription",
      laneBilling: "subscription",
      containerStatus: "running",
      containerId: "abc123",
      containerName: "interlude-task-frob",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
}

/** The Claude Code artefact the pause copies: one file, at the adapter's path. */
const TRANSCRIPT_PATH = claudeTranscriptPath(SESSION_ID, AGENT_WORKDIR);

/** The subscription lane, as the resolver hands it to a resumed pass. */
const SUBSCRIPTION_LANE: ResolvedLane = {
  id: "claude-subscription",
  label: "Claude subscription (Pro)",
  adapter: "claude-code",
  capabilities: {
    userInvokedSkills: true,
    quotaTelemetry: true,
    reportsCost: true,
    sessionResume: true,
  },
  billing: "subscription",
  auth: { CLAUDE_CODE_OAUTH_TOKEN: "oauth" },
  baseUrl: null,
  tier: "standard",
  model: "sonnet",
  prices: null,
  declaresPrices: false,
  caps: { dailyBudgetUsd: null },
};

/** The stored transcript as the pause writes it for a Claude Code session. */
function storedTranscript(contents: string = TRANSCRIPT) {
  return {
    adapter: "claude-code",
    sessionId: SESSION_ID,
    artefacts: [{ path: TRANSCRIPT_PATH, contents: Buffer.from(contents, "utf8") }],
  };
}

/**
 * Turn the seeded pass into the *resumed* one (issue #169's executor's shape):
 * the pass it continues is a failed row on the subscription lane, and this row
 * carries its session id and the lineage that names it.
 */
function seedResumedPass(): void {
  const pausedId = newId();
  testDb
    .insert(schema.tasks)
    .values({
      id: pausedId,
      projectId,
      title: "Add the frobnicator",
      description: "the implement brief",
      status: "failed",
      kind: "implement",
      runId,
      githubIssue: ISSUE_REF,
      branch: "agent/issue-34",
      sessionId: SESSION_ID,
      lane: "claude-subscription",
      laneBilling: "subscription",
      createdAt: new Date(Date.now() - 60_000),
      updatedAt: new Date(Date.now() - 60_000),
    })
    .run();
  testDb
    .update(schema.tasks)
    .set({ status: "queued", lane: null, laneBilling: null, resumedFromTaskId: pausedId })
    .where(eq(schema.tasks.id, taskId))
    .run();
}

function run() {
  return testDb.select().from(schema.runs).where(eq(schema.runs.id, runId)).get()!;
}

function task() {
  return testDb.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get()!;
}

describe("a quota pause keeps the pass's conversation (issue #169)", () => {
  let turns: TurnManager;

  beforeEach(async () => {
    testDb = createTestDb().db;
    // The store follows DATABASE_URL, so pointing it at a temp directory is
    // all it takes to exercise the real filesystem path.
    storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "interlude-resume-"));
    process.env.DATABASE_URL = path.join(storeRoot, "interlude.db");
    docker.calls.length = 0;
    docker.written.clear();
    docker.writeFails = false;
    docker.readFails = false;
    docker.fileContents = Buffer.from(TRANSCRIPT, "utf8");
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
    fs.rmSync(storeRoot, { recursive: true, force: true });
    delete process.env.DATABASE_URL;
    vi.restoreAllMocks();
  });

  it("copies the transcript out before the container is torn down", async () => {
    await turns.evaluatePassOutcome(taskId, WALLED_TURN);

    // The ordering is the whole trick: the conversation only exists inside the
    // container the pause is about to remove.
    expect(docker.calls).toEqual(["readContainerFile", "removeContainer"]);
    const stored = readTranscript(runId);
    // Exactly the adapter's artefacts, kept with the path they came from and
    // whose they are (issue #217).
    expect(stored?.adapter).toBe("claude-code");
    expect(stored?.sessionId).toBe(SESSION_ID);
    expect(stored?.artefacts.map((a) => a.path)).toEqual([TRANSCRIPT_PATH]);
    expect(stored?.artefacts[0].contents.toString("utf8")).toBe(TRANSCRIPT);
  });

  it("says on the issue that the resume will continue the conversation", async () => {
    await turns.evaluatePassOutcome(taskId, WALLED_TURN);

    expect(github.comments.join("\n")).toContain("resumes the same conversation");
  });

  it("pauses exactly as before when the transcript cannot be read", async () => {
    docker.fileContents = null;

    const decision = await turns.evaluatePassOutcome(taskId, WALLED_TURN);

    // A transcript is a saving, not the protection: the pause protects the
    // ticket's attempt, and must not depend on the copy succeeding.
    expect(decision).toBe("paused");
    expect(run().status).toBe("rate_limited");
    expect(run().resumeAfter).toEqual(RESUME_AFTER);
    expect(run().attempt).toBe(1);
    expect(readTranscript(runId)).toBeNull();
    expect(docker.calls).toContain("removeContainer");
  });

  it("survives a container read that throws", async () => {
    docker.readFails = true;

    expect(await turns.evaluatePassOutcome(taskId, WALLED_TURN)).toBe("paused");
    expect(run().status).toBe("rate_limited");
    expect(readTranscript(runId)).toBeNull();
    // Still torn down: a failed copy must not leave the container behind.
    expect(docker.calls).toContain("removeContainer");
  });

  it("spends no attempt and no resume — the sweep decides the resume", async () => {
    await turns.evaluatePassOutcome(taskId, WALLED_TURN);

    expect(run().attempt).toBe(1);
    expect(run().interruptionCount).toBe(0);
    // The bound counts resumes, and none has happened yet: the pause itself is
    // free, which is what lets the bound mean "how often this was retried".
    expect(run().resumeCount).toBe(0);
  });
});

describe("a resumed pass opening in a fresh container (issue #169)", () => {
  let turns: TurnManager;

  beforeEach(async () => {
    testDb = createTestDb().db;
    storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "interlude-resume-"));
    process.env.DATABASE_URL = path.join(storeRoot, "interlude.db");
    docker.calls.length = 0;
    docker.written.clear();
    docker.writeFails = false;
    docker.readFails = false;
    github.comments.length = 0;
    vi.resetModules();
    turns = await import("../turn-manager");
    seedImplementPass();
    seedResumedPass();
  });

  afterEach(() => {
    fs.rmSync(storeRoot, { recursive: true, force: true });
    delete process.env.DATABASE_URL;
    vi.restoreAllMocks();
  });

  const container = {
    id: "def456",
    name: "interlude-task-frob-2",
    previewSubdomain: "task-frob2",
    container: {} as never,
  };

  it("restores the transcript and continues the same session", async () => {
    saveTranscript(runId, storedTranscript());

    const sessionId = await turns.restoreSessionTranscript(task(), container, SUBSCRIPTION_LANE);

    expect(sessionId).toBe(SESSION_ID);
    // Where the harness keeps it: one file, named for the session, under the
    // mangled working directory (the #165 spike's finding) — the path the
    // store recorded, which is the adapter's.
    expect(docker.written.get(TRANSCRIPT_PATH)).toBe(TRANSCRIPT);
    expect(task().sessionId).toBe(SESSION_ID);
  });

  it("falls back to a fresh pass when nothing was stored", async () => {
    const sessionId = await turns.restoreSessionTranscript(task(), container, SUBSCRIPTION_LANE);

    // Never `--resume` against a session the container has never heard of:
    // that fails the pass, where the fallback merely costs it its context.
    expect(sessionId).toBeUndefined();
    expect(docker.written.size).toBe(0);
    expect(task().sessionId).toBeNull();
  });

  it("falls back when the restore itself fails", async () => {
    saveTranscript(runId, storedTranscript());
    docker.writeFails = true;

    expect(
      await turns.restoreSessionTranscript(task(), container, SUBSCRIPTION_LANE)
    ).toBeUndefined();
  });

  it("leaves an ordinary first pass alone", async () => {
    // Only the resume, move and degrade executors record a predecessor, so a
    // task without one must not go looking for a transcript at all.
    testDb
      .update(schema.tasks)
      .set({ sessionId: null, resumedFromTaskId: null })
      .where(eq(schema.tasks.id, taskId))
      .run();

    expect(
      await turns.restoreSessionTranscript(task(), container, SUBSCRIPTION_LANE)
    ).toBeUndefined();
    expect(docker.calls).toEqual([]);
  });

  it("says nothing for a continuation queued without a session", async () => {
    // A degrade (#170) carries none by design, and a pause whose transcript did
    // not survive already said so on the refused pass's feed and on the issue.
    testDb
      .update(schema.tasks)
      .set({ sessionId: null })
      .where(eq(schema.tasks.id, taskId))
      .run();
    const before = testDb.select().from(schema.messages).all().length;

    expect(
      await turns.restoreSessionTranscript(task(), container, SUBSCRIPTION_LANE)
    ).toBeUndefined();
    expect(testDb.select().from(schema.messages).all().length).toBe(before);
  });
});
