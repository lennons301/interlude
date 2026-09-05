import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/create-test-db";
import * as schema from "@/db/schema";
import { newId } from "@/lib/ulid";
import {
  createFakeHarness,
  fakeExecStream,
  fakeLaneCatalog,
  scriptedTurn,
  FAKE_HARNESS_ID,
  FAKE_LANE_AUTH_VAR,
  FAKE_LANE_ID,
  type FakeHarness,
} from "@/test/fake-harness";

/**
 * A whole turn through the turn manager on the fake adapter (issue #214): lane
 * resolution, the exec the adapter is asked to build, the scripted outcome,
 * and what the reducer then does to the run — with no Claude Code and no
 * Docker stream anywhere. This is the shape every later ticket in the
 * multi-harness milestone tests the orchestrator in.
 *
 * Driven through the real `startTask` over a real (in-memory, migrated)
 * database and a one-lane catalog on the fake adapter. Only outbound I/O is
 * stubbed (Docker, GitHub, Discord), exactly as the quota-pause and
 * repair-tier suites stub it; the DB writes, the reducer and the container
 * teardown ordering are the real thing.
 */

let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const docker = vi.hoisted(() => ({
  /** Container-manager calls in order. */
  calls: [] as string[],
  /** The agent image each container was asked to run (issue #216). */
  images: [] as { name: string; dockerfile: string }[],
}));

vi.mock("../../docker/container-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../docker/container-manager")>();
  return {
    ...actual,
    createWorkspaceContainer: async (options: { image: { name: string; dockerfile: string } }) => {
      docker.calls.push("createWorkspaceContainer");
      docker.images.push(options.image);
      return {
        container: { start: async () => undefined },
        id: "ctr-fake",
        name: "interlude-agent-fake",
        previewSubdomain: "task-fake",
      };
    },
    execSetup: async () => ({ skillsVersion: "9.9.9" }),
    execAgentTurn: async () => {
      docker.calls.push("execAgentTurn");
      return fakeExecStream();
    },
    execFallbackCommitAndPush: async () => {
      docker.calls.push("push");
      return { commitsAhead: 1 };
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

const github = vi.hoisted(() => ({ comments: [] as string[], prReady: [] as number[] }));

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
    markPrReady: async (_owner: string, _repo: string, number: number) => {
      github.prReady.push(number);
    },
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

// The one-lane catalog on the fake adapter, in place of `lanes.yaml`. Every
// reader of the catalog — lane resolution, the crossing, the failover ranking
// — sees the same file, exactly as they would in production.
vi.mock("../../lanes/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lanes/catalog")>();
  return {
    ...actual,
    getLaneCatalog: () => ({ ok: true, catalog: fakeLaneCatalog() }),
  };
});

type TurnManager = typeof import("../turn-manager");

const ISSUE_REF = "lennons301/lemons#34";
const RESUME_AFTER = new Date("2026-09-06T17:00:00.000Z");
const BRIEF = "Implement issue #34 — add the frobnicator.";

let runId: string;
let taskId: string;

/** A claimed implement attempt, queued and awaiting its container. */
function seedImplementPass(): void {
  const projectId = newId();
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
      status: "claimed",
      budgetUsd: 20,
      model: "heavy",
      claimedAt: new Date(),
    })
    .run();
  taskId = newId();
  testDb
    .insert(schema.tasks)
    .values({
      id: taskId,
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
}

function run() {
  return testDb.select().from(schema.runs).where(eq(schema.runs.id, runId)).get()!;
}

function task() {
  return testDb.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get()!;
}

describe("a whole turn through the turn manager on the fake adapter (issue #214)", () => {
  let turns: TurnManager;
  let fake: FakeHarness;
  let unregister: () => void;
  const env = { ...process.env };

  beforeEach(async () => {
    testDb = createTestDb().db;
    docker.calls.length = 0;
    github.comments.length = 0;
    github.prReady.length = 0;
    // The fake lane's credential, so it resolves as available. A value, never
    // a real token. No explicit lane choice, so the catalog's preference — the
    // fake lane — is the primary.
    process.env[FAKE_LANE_AUTH_VAR] = "fake-token";
    delete process.env.AGENT_LANE;
    delete process.env.AGENT_MODEL;
    vi.resetModules();
    const config = await import("@/lib/config");
    config.resetConfig();
    // Register on the registry instance the freshly imported turn manager
    // will resolve through: modules were just reset, so it must be imported
    // after the reset too.
    const registry = await import("@/lib/harness/registry");
    fake = createFakeHarness();
    unregister = registry.registerHarnessAdapter(fake.adapter);
    turns = await import("../turn-manager");
    turns.getActiveTasks().clear();
    seedImplementPass();
  });

  afterEach(() => {
    unregister();
    process.env = { ...env };
    vi.restoreAllMocks();
  });

  it("resolves the fake lane, asks the adapter for the exec, and completes the pass on a completed outcome", async () => {
    fake.script(scriptedTurn({ kind: "completed" }, { sessionId: "fake-sess", costUsd: 0.25 }));

    await turns.startTask(taskId);

    // The pass ran on the fake lane, at the run's tier, on the adapter's model
    // for it — recorded on the rows exactly as a Claude lane's pass would be.
    expect(task().lane).toBe(FAKE_LANE_ID);
    expect(task().tier).toBe("heavy");
    expect(run().lane).toBe(FAKE_LANE_ID);
    expect(run().model).toBe("heavy");
    // And the harness that ran it, stamped on both rows from the resolved lane
    // (issue #223) — never recovered from the lane id later.
    expect(task().harness).toBe(FAKE_HARNESS_ID);
    expect(run().harness).toBe(FAKE_HARNESS_ID);

    // The adapter was asked for exactly one exec, with the pass's brief as
    // the prompt and the lane it resolved.
    expect(fake.execs).toHaveLength(1);
    expect(fake.execs[0].taskId).toBe(taskId);
    expect(fake.execs[0].laneId).toBe(FAKE_LANE_ID);
    expect(fake.execs[0].env.prompt).toBe(BRIEF);
    expect(fake.execs[0].env.ghToken).toBeNull();
    expect(fake.execs[0].env.lane.auth).toEqual({ [FAKE_LANE_AUTH_VAR]: "fake-token" });
    expect(fake.execs[0].command.lane.model).toBe("fake-heavy");
    expect(fake.execs[0].command.sessionId).toBeUndefined();

    // A completed outcome is the ordinary implement path: the branch is
    // pushed, the draft PR opened and marked ready, the run records it and the
    // container is parked awaiting review.
    expect(docker.calls).toEqual([
      "createWorkspaceContainer",
      "execAgentTurn",
      "push",
      "stopContainer",
    ]);
    // The container runs the image the lane's adapter declares (issue #216) —
    // the fake's, not the Claude Code image the fleet has always built.
    expect(docker.images).toEqual([fake.adapter.image]);
    expect(docker.images[0].name).not.toBe("interlude-agent-claude-code:latest");
    expect(github.prReady).toEqual([41]);
    expect(run().status).toBe("implementing");
    expect(run().pullRequestNumber).toBe(41);
    expect(task().sessionId).toBe("fake-sess");
    expect(task().totalCostUsd).toBe(0.25);
    expect(task().containerStatus).toBe("idle");
    expect(fake.pending()).toBe(0);
  });

  it("parks the run on a scripted refused { quota } — the refusal reaches the reducer as a refusal", async () => {
    fake.script(
      scriptedTurn(
        {
          kind: "refused",
          refusal: { kind: "quota", resumeAfter: RESUME_AFTER, limitType: "five_hour" },
        },
        { finalMessage: "The provider refused the request.", costUsd: 0 }
      )
    );

    await turns.startTask(taskId);

    // The reducer's wall ordering ran on the normalised outcome alone: no lane
    // to fail over to (the catalog has one), no tier named by the window, so
    // the run pauses on the clock — spending neither an attempt nor an
    // interruption, with the container removed rather than parked (#168).
    expect(run().status).toBe("rate_limited");
    expect(run().resumeAfter).toEqual(RESUME_AFTER);
    expect(run().attempt).toBe(1);
    expect(run().interruptionCount).toBe(0);
    expect(run().finishedAt).toBeNull();
    expect(task().status).toBe("failed");
    expect(docker.calls).toEqual([
      "createWorkspaceContainer",
      "execAgentTurn",
      "push",
      "removeContainer",
    ]);
    expect(github.comments.some((c) => c.includes("5-hour window"))).toBe(true);
  });

  it("steps the run down the ladder on a refusal naming a tier's window", async () => {
    fake.script(
      scriptedTurn({
        kind: "refused",
        refusal: { kind: "quota", resumeAfter: RESUME_AFTER, limitType: "seven_day_opus" },
      })
    );

    await turns.startTask(taskId);

    // Degrade outranks the pause (issue #170): the window named the heavy tier,
    // so the run steps to standard and a replacement pass is queued.
    expect(run().status).toBe("implementing");
    expect(run().model).toBe("standard");
    expect(run().degradedFrom).toBe("heavy");
    const queued = testDb
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.runId, runId))
      .all()
      .filter((t) => t.status === "queued");
    expect(queued).toHaveLength(1);
    expect(queued[0].resumedFromTaskId).toBe(taskId);
  });

  it("fails the attempt on a scripted turn-limit, as a turn-limited Claude turn does", async () => {
    fake.script(scriptedTurn({ kind: "turn-limit" }));

    await turns.startTask(taskId);

    expect(run().status).toBe("failed");
    expect(run().failureReason).toContain("turn limit reached");
    expect(task().status).toBe("failed");
    expect(docker.calls).toContain("removeContainer");
  });

  it("treats a turn with no outcome as an interruption, not a spent attempt", async () => {
    // The adapter reported nothing about how the turn ended — the container
    // died mid-turn. That is the interruption bound's case (issue #97), and it
    // must stay so on every harness.
    fake.script(scriptedTurn(null, { finalMessage: null, costUsd: 0 }));

    await turns.startTask(taskId);

    expect(run().status).toBe("interrupted");
    expect(run().interruptionCount).toBe(1);
    expect(run().attempt).toBe(1);
    expect(task().status).toBe("failed");
  });

  it("takes the ordinary path on a non-quota refusal, exactly as before the vocabulary existed", async () => {
    // A refused credential is not a wall (its consequence is issue #220's): the
    // pass had left a PR behind, so it finishes like any other implement pass.
    fake.script(
      scriptedTurn(
        { kind: "refused", refusal: { kind: "auth", resumeAfter: null, limitType: null } },
        { finalMessage: "401 Unauthorized" }
      )
    );

    await turns.startTask(taskId);

    expect(run().status).toBe("implementing");
    expect(run().resumeAfter).toBeNull();
    expect(run().pullRequestNumber).toBe(41);
    expect(docker.calls).toEqual([
      "createWorkspaceContainer",
      "execAgentTurn",
      "push",
      "stopContainer",
    ]);
  });
});
