import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/create-test-db";
import * as schema from "@/db/schema";
import { newId } from "@/lib/ulid";
import { hasTranscript, readTranscript, saveTranscript } from "@/lib/quota/session-transcript";
import { AGENT_WORKDIR } from "@/lib/docker/container-manager";
import {
  createFakeHarness,
  fakeExecStream,
  fakeLaneCatalogOf,
  fakeSessionArtifactPath,
  scriptedTurn,
  FAKE_HARNESS_CAPABILITIES,
  FAKE_HARNESS_ID,
  FAKE_LANE_AUTH_VAR,
  FAKE_NO_RESUME_HARNESS_ID,
  FAKE_OTHER_HARNESS_ID,
  type FakeHarness,
} from "@/test/fake-harness";

/**
 * A session crossing lanes on two different adapters (issue #217), driven
 * through the real `startTask` over a real (in-memory, migrated) database, a
 * real transcript store on disk and a catalog of fake lanes on three fake
 * adapters — two that resume sessions, one that cannot.
 *
 * What the pass it continues left behind is seeded as the resume, move and
 * degrade executors leave it (`resumedFromTaskId`, the session id, the
 * predecessor's lane on its own row); which lane the pass starts on is pinned
 * with `AGENT_LANE`, the operator's explicit choice, so the ranking is not the
 * thing under test. Only outbound I/O is stubbed (Docker, GitHub, Discord),
 * exactly as `fake-harness-turn.test.ts` stubs it.
 */

let testDb: ReturnType<typeof createTestDb>["db"];
let storeRoot: string;

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const docker = vi.hoisted(() => ({
  /** Container-manager calls in order. */
  calls: [] as string[],
  /** What reading any file out of the container answers with. */
  fileContents: Buffer.from('{"fake":"session"}\n'),
  /** Files written into the container: path -> bytes. */
  written: new Map<string, string>(),
}));

vi.mock("../../docker/container-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../docker/container-manager")>();
  return {
    ...actual,
    createWorkspaceContainer: async () => {
      docker.calls.push("createWorkspaceContainer");
      return {
        container: { start: async () => undefined },
        id: "ctr-fake",
        name: "interlude-agent-fake",
        previewSubdomain: "task-fake",
      };
    },
    execSetup: async () => undefined,
    execAgentTurn: async () => {
      docker.calls.push("execAgentTurn");
      return fakeExecStream();
    },
    execFallbackCommitAndPush: async () => {
      docker.calls.push("push");
      return { commitsAhead: 1 };
    },
    readContainerFile: async (_container: unknown, filePath: string) => {
      docker.calls.push(`readContainerFile ${filePath}`);
      return docker.fileContents;
    },
    writeContainerFile: async (_container: unknown, filePath: string, contents: Buffer | string) => {
      docker.calls.push(`writeContainerFile ${filePath}`);
      docker.written.set(filePath, contents.toString());
    },
    observeContainerAbsent: async () => false,
    startContainer: async () => docker.calls.push("startContainer"),
    stopContainer: async () => docker.calls.push("stopContainer"),
    removeContainer: async () => docker.calls.push("removeContainer"),
  };
});

vi.mock("../../github/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../github/client")>();
  return { ...actual, getInstallationToken: async () => "ghs_fake_installation" };
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

vi.mock("../../github/pull-requests", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../github/pull-requests")>();
  return {
    ...actual,
    createDraftPr: async () => ({
      number: 41,
      url: "https://github.com/lennons301/lemons/pull/41",
      adopted: false,
    }),
    markPrReady: async () => undefined,
  };
});

vi.mock("../../discord/notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../discord/notifications")>();
  return {
    ...actual,
    notifyTaskQueued: async () => null,
    notifyTaskCompleted: async () => null,
    notifyTaskFailed: async () => null,
    notifyRunBlocked: async () => null,
  };
});

/** Four lanes on three fake adapters: two on the first fake (a same-adapter
 * move has somewhere to go), one on the second fake, one on the fake that
 * cannot resume a session. */
const LANES = [
  { id: "fake-lane", adapter: FAKE_HARNESS_ID, label: "Fake harness" },
  { id: "fake-lane-b", adapter: FAKE_HARNESS_ID, label: "Fake harness (B)" },
  { id: "other-lane", adapter: FAKE_OTHER_HARNESS_ID, label: "Other harness" },
  { id: "no-resume-lane", adapter: FAKE_NO_RESUME_HARNESS_ID, label: "Forgetful harness" },
] as const;

/** Which of the lanes above the file declares this test — all of them, or the
 * named few, so a wall can be given nowhere to fail over to. */
const declared = vi.hoisted(() => ({ only: null as readonly string[] | null }));

vi.mock("../../lanes/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lanes/catalog")>();
  return {
    ...actual,
    getLaneCatalog: () => ({
      ok: true,
      catalog: fakeLaneCatalogOf(
        declared.only === null ? LANES : LANES.filter((lane) => declared.only!.includes(lane.id))
      ),
    }),
  };
});

type TurnManager = typeof import("../turn-manager");
type PausedRuns = typeof import("../autonomy/paused-runs");

const ISSUE_REF = "lennons301/lemons#34";
const RESUME_AFTER = new Date("2026-09-06T17:00:00.000Z");
const BRIEF = "Implement issue #34 — add the frobnicator.";
const SESSION = "fake-session-1";
/** Where the first fake keeps the session — the path the pause stored. */
const FAKE_ARTIFACT = fakeSessionArtifactPath(FAKE_HARNESS_ID, SESSION, AGENT_WORKDIR);

let projectId: string;
let runId: string;

/** A run mid-attempt whose implement pass ran on `fake-lane` and was refused. */
function seedRun(): void {
  projectId = newId();
  testDb
    .insert(schema.projects)
    .values({
      id: projectId,
      name: "lemons",
      gitUrl: "https://github.com/lennons301/lemons.git",
      createdAt: new Date(),
    })
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
      model: "heavy",
      lane: "fake-lane",
      laneBilling: "subscription",
      resumeCount: 1,
      claimedAt: new Date(),
      startedAt: new Date(),
    })
    .run();
}

/** The refused pass: failed, on `laneId`, with the session it was in. */
function seedPredecessor(laneId: string | null): string {
  const id = newId();
  testDb
    .insert(schema.tasks)
    .values({
      id,
      projectId,
      title: "Add the frobnicator",
      description: BRIEF,
      status: "failed",
      kind: "implement",
      runId,
      githubIssue: ISSUE_REF,
      branch: "agent/issue-34",
      sessionId: SESSION,
      lane: laneId,
      laneBilling: laneId === null ? null : "subscription",
      createdAt: new Date(Date.now() - 60_000),
      updatedAt: new Date(Date.now() - 60_000),
    })
    .run();
  return id;
}

/** The continuation, as the resume and move executors queue it: the same
 * brief, the predecessor's session where its transcript is on disk, and the
 * lineage that names it. */
function seedContinuation(predecessorId: string, sessionId: string | null): string {
  const id = newId();
  testDb
    .insert(schema.tasks)
    .values({
      id,
      projectId,
      title: "Add the frobnicator",
      description: BRIEF,
      status: "queued",
      kind: "implement",
      runId,
      githubIssue: ISSUE_REF,
      branch: "agent/issue-34",
      sessionId,
      resumedFromTaskId: predecessorId,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  return id;
}

/** What the pause left in the store: the first fake's one artefact. */
function storeFakeTranscript(): void {
  expect(
    saveTranscript(runId, {
      adapter: FAKE_HARNESS_ID,
      sessionId: SESSION,
      artefacts: [{ path: FAKE_ARTIFACT, contents: docker.fileContents }],
    })
  ).toBe(true);
}

function run() {
  return testDb.select().from(schema.runs).where(eq(schema.runs.id, runId)).get()!;
}

function task(id: string) {
  return testDb.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!;
}

function systemNotes(taskId: string): string[] {
  return testDb
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.taskId, taskId))
    .all()
    .filter((m) => m.role === "system")
    .map((m) => JSON.parse(m.content).text as string);
}

describe("a session crossing lanes on different adapters (issue #217)", () => {
  let turns: TurnManager;
  let pausedRuns: PausedRuns;
  let fake: FakeHarness;
  let other: FakeHarness;
  let noResume: FakeHarness;
  const unregister: (() => void)[] = [];
  const env = { ...process.env };

  /** Pin the next pass to `laneId` — the operator's explicit choice, read
   * fresh because the config memoises on first read. */
  async function pin(laneId: string): Promise<void> {
    process.env.AGENT_LANE = laneId;
    (await import("@/lib/config")).resetConfig();
  }

  /** Boot the turn manager with the pass pinned to `laneId`. */
  async function boot(laneId: string): Promise<void> {
    process.env[FAKE_LANE_AUTH_VAR] = "fake-token";
    delete process.env.AGENT_MODEL;
    delete process.env.AGENT_MIN_LANE;
    vi.resetModules();
    await pin(laneId);
    const registry = await import("@/lib/harness/registry");
    fake = createFakeHarness();
    other = createFakeHarness([], { id: FAKE_OTHER_HARNESS_ID });
    noResume = createFakeHarness([], {
      id: FAKE_NO_RESUME_HARNESS_ID,
      capabilities: { ...FAKE_HARNESS_CAPABILITIES, sessionResume: false },
    });
    for (const harness of [fake, other, noResume]) {
      unregister.push(registry.registerHarnessAdapter(harness.adapter));
    }
    turns = await import("../turn-manager");
    pausedRuns = await import("../autonomy/paused-runs");
    turns.getActiveTasks().clear();
  }

  beforeEach(() => {
    testDb = createTestDb().db;
    // The store follows DATABASE_URL, so pointing it at a temp directory is
    // all it takes to exercise the real filesystem path.
    storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "interlude-carry-"));
    process.env.DATABASE_URL = path.join(storeRoot, "interlude.db");
    docker.calls.length = 0;
    docker.written.clear();
    github.comments.length = 0;
    declared.only = null;
    seedRun();
  });

  afterEach(() => {
    while (unregister.length > 0) unregister.pop()!();
    fs.rmSync(storeRoot, { recursive: true, force: true });
    process.env = { ...env };
    vi.restoreAllMocks();
  });

  it("starts fresh on the branch across two adapters: no restore, session id cleared, both lanes named", async () => {
    storeFakeTranscript();
    const predecessor = seedPredecessor("fake-lane");
    const taskId = seedContinuation(predecessor, SESSION);
    await boot("other-lane");
    other.script(scriptedTurn({ kind: "completed" }, { sessionId: "other-session-9" }));

    await turns.startTask(taskId);

    // The pass ran on the other adapter, asked to start a fresh conversation:
    // no `--resume`, and nothing written into its container.
    expect(other.execs).toHaveLength(1);
    expect(other.execs[0].laneId).toBe("other-lane");
    expect(other.execs[0].command.sessionId).toBeUndefined();
    expect(fake.execs).toHaveLength(0);
    expect(docker.calls.some((c) => c.startsWith("writeContainerFile"))).toBe(false);
    expect(docker.written.size).toBe(0);

    // The owner is told, on the pass's own feed, which two lanes and why.
    const note = systemNotes(taskId).find((n) => n.startsWith("Starting again on the branch"));
    expect(note).toBeDefined();
    expect(note).toContain("Fake harness");
    expect(note).toContain("Other harness");
    expect(note).toContain(FAKE_HARNESS_ID);
    expect(note).toContain(FAKE_OTHER_HARNESS_ID);
    expect(note).toContain("cannot be carried between two different harnesses");

    // The row records the new harness's own session, never the old one; the
    // pass completed as an ordinary implement pass, and the move cost the
    // attempt nothing.
    expect(task(taskId).sessionId).toBe("other-session-9");
    expect(task(taskId).lane).toBe("other-lane");
    expect(run().status).toBe("implementing");
    expect(run().attempt).toBe(1);
    expect(run().pullRequestNumber).toBe(41);
    expect(docker.calls.filter((c) => !c.includes("ContainerFile"))).toEqual([
      "createWorkspaceContainer",
      "execAgentTurn",
      "push",
      "stopContainer",
    ]);
  });

  it("restores and resumes the conversation across two lanes on the same adapter", async () => {
    storeFakeTranscript();
    const predecessor = seedPredecessor("fake-lane");
    const taskId = seedContinuation(predecessor, SESSION);
    await boot("fake-lane-b");
    fake.script(scriptedTurn({ kind: "completed" }, { sessionId: SESSION }));

    await turns.startTask(taskId);

    // The adapter's artefact went back to the path the store recorded, and the
    // turn continued the session.
    expect(docker.written.get(FAKE_ARTIFACT)).toBe(docker.fileContents.toString());
    expect(fake.execs).toHaveLength(1);
    expect(fake.execs[0].laneId).toBe("fake-lane-b");
    expect(fake.execs[0].command.sessionId).toBe(SESSION);
    expect(systemNotes(taskId)).toContain(
      `Restored the paused session (${SESSION}) — continuing the same conversation.`
    );
    expect(task(taskId).sessionId).toBe(SESSION);
  });

  it("starts fresh when the lane the conversation came from is no longer declared", async () => {
    storeFakeTranscript();
    const predecessor = seedPredecessor("retired-lane");
    const taskId = seedContinuation(predecessor, SESSION);
    await boot("fake-lane");
    fake.script(scriptedTurn({ kind: "completed" }, { sessionId: "fresh-session" }));

    await turns.startTask(taskId);

    expect(fake.execs[0].command.sessionId).toBeUndefined();
    expect(docker.written.size).toBe(0);
    expect(systemNotes(taskId).join("\n")).toContain("(retired-lane) is no longer declared");
    expect(task(taskId).sessionId).toBe("fresh-session");
  });

  /** A first implement pass, queued with no predecessor. */
  function seedFirstPass(): string {
    const id = newId();
    testDb
      .insert(schema.tasks)
      .values({
        id,
        projectId,
        title: "Add the frobnicator",
        description: BRIEF,
        status: "queued",
        kind: "implement",
        runId,
        githubIssue: ISSUE_REF,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
    return id;
  }

  /** The turn the fake that cannot resume reports at an account-wide wall. */
  const WALLED = () =>
    scriptedTurn(
      {
        kind: "refused",
        refusal: { kind: "quota", resumeAfter: RESUME_AFTER, limitType: "five_hour" },
      },
      { sessionId: "forgetful-session", costUsd: 0 }
    );

  it("fails over onto another adapter's lane, whose replacement starts fresh and says so", async () => {
    const taskId = seedFirstPass();
    await boot("no-resume-lane");
    noResume.script(WALLED());

    // The wall releases the pin (#176), and the ranking's next lane runs a
    // different adapter — a legal target: the move costs the conversation,
    // never the attempt. Nothing is copied out, because nothing could be put
    // back anywhere, and the replacement is queued carrying no session.
    await turns.startTask(taskId);

    expect(run().status).toBe("implementing");
    expect(run().attempt).toBe(1);
    expect(run().resumeCount).toBe(2);
    expect(docker.calls.some((c) => c.startsWith("readContainerFile"))).toBe(false);
    const replacement = testDb
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.status, "queued"))
      .all();
    expect(replacement).toHaveLength(1);
    expect(replacement[0].sessionId).toBeNull();
    expect(replacement[0].resumedFromTaskId).toBe(taskId);

    // The replacement starts on the other adapter and its feed names both. The
    // move's target is advisory — `startTask` re-asks the ranking (#176) — and
    // a harness with no quota telemetry leaves no wall on its row for the
    // ranking to route around, so the replacement is pinned where the move
    // sent it, as the wall's own `rejected` row would on a Claude lane.
    await pin("fake-lane");
    docker.calls.length = 0;
    fake.script(scriptedTurn({ kind: "completed" }, { sessionId: "fake-fresh" }));
    await turns.startTask(replacement[0].id);

    expect(fake.execs).toHaveLength(1);
    expect(fake.execs[0].laneId).toBe("fake-lane");
    expect(fake.execs[0].command.sessionId).toBeUndefined();
    expect(docker.calls.some((c) => c.includes("ContainerFile"))).toBe(false);
    const note = systemNotes(replacement[0].id).find((n) => n.startsWith("Starting again on the branch"));
    expect(note).toContain("Forgetful harness");
    expect(note).toContain("Fake harness");
    expect(note).toContain("cannot be carried between two different harnesses");
    expect(task(replacement[0].id).sessionId).toBe("fake-fresh");
  });

  describe("a run on an adapter that declares no session resume", () => {
    it("pauses with nothing copied out, and resumes as a fresh start with the same note", async () => {
      // The only lane declared, so the wall has nowhere to fail over to.
      declared.only = ["no-resume-lane"];
      const taskId = seedFirstPass();
      await boot("no-resume-lane");
      noResume.script(WALLED());

      // The wall: the run pauses, and the pause reads nothing out of the
      // container — there is nothing that could ever be put back.
      await turns.startTask(taskId);

      expect(run().status).toBe("rate_limited");
      expect(run().resumeAfter).toEqual(RESUME_AFTER);
      expect(docker.calls.some((c) => c.startsWith("readContainerFile"))).toBe(false);
      expect(hasTranscript(runId)).toBe(false);
      expect(readTranscript(runId)).toBeNull();
      expect(systemNotes(taskId).join("\n")).toContain("could not be copied out");

      // The window resets and the sweep resumes it: the queued pass carries
      // no session, because nothing is on disk.
      await pausedRuns.executeResumeRun({
        type: "resumeRun",
        runId,
        issueRef: ISSUE_REF,
        resume: 2,
        maxResumes: 3,
      });
      const resumed = testDb
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.status, "queued"))
        .all();
      expect(resumed).toHaveLength(1);
      expect(resumed[0].sessionId).toBeNull();
      expect(resumed[0].resumedFromTaskId).toBe(taskId);
      expect(github.comments.join("\n")).toContain("could not be preserved");

      // The resumed pass starts fresh, on the same adapter, and its own feed
      // says why: the harness cannot resume a session.
      docker.calls.length = 0;
      noResume.script(scriptedTurn({ kind: "completed" }, { sessionId: "forgetful-session-2" }));
      await turns.startTask(resumed[0].id);

      expect(noResume.execs).toHaveLength(2);
      expect(noResume.execs[1].command.sessionId).toBeUndefined();
      expect(docker.calls.some((c) => c.includes("ContainerFile"))).toBe(false);
      const note = systemNotes(resumed[0].id).find((n) => n.startsWith("Starting again on the branch"));
      expect(note).toContain("Forgetful harness runs fake-no-resume, which cannot resume a session");
      expect(run().status).toBe("implementing");
      expect(run().resumeAfter).toBeNull();
      expect(run().attempt).toBe(1);
    });
  });
});
