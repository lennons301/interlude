import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/create-test-db";
import * as schema from "@/db/schema";
import { newId } from "@/lib/ulid";
import {
  createFakeHarness,
  fakeExecStream,
  fakeLaneCatalog,
  fakeLaneCatalogOf,
  hangingTurn,
  scriptedTurn,
  FAKE_HARNESS_ID,
  FAKE_LANE_AUTH_VAR,
  FAKE_LANE_ID,
  type FakeHarness,
} from "@/test/fake-harness";
import { DEFAULT_REFUSAL_BACKOFF_MS } from "../autonomy/budgets";

/**
 * A whole turn through the turn manager on the fake adapter (issue #214): lane
 * resolution, the exec the adapter is asked to build, the scripted outcome,
 * and what the reducer then does to the run — with no Claude Code and no
 * Docker stream anywhere. This is the shape every later ticket in the
 * multi-harness milestone tests the orchestrator in.
 *
 * Driven through the real `startTask` over a real (in-memory, migrated)
 * database and a one-lane catalog on the fake adapter — two lanes where a
 * case needs somewhere to move to. Only outbound I/O is stubbed (Docker,
 * GitHub, Discord), exactly as the quota-pause and repair-tier suites stub
 * it; the DB writes, the reducer and the container teardown ordering are the
 * real thing.
 *
 * Issue #220 adds the cases a harness with no rate-limit event and no CLI
 * ceiling needs: the full wall ordering on a `refused { quota }` (degrade,
 * failover, park), a park on the default backoff when the refusal named no
 * reset, a `refused { auth }` ending the pass without a retry on its lane, and
 * a turn the orchestrator's wall-clock ceiling ends as a turn limit.
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
    stopAgentTurn: async () => {
      docker.calls.push("stopAgentTurn");
      return "stopped";
    },
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
// — sees the same file, exactly as they would in production. A case that
// needs a second lane to move to (issue #220's failover) declares two lanes
// on the same fake adapter, so the move is the wall ordering's and not #217's.
const lanes = vi.hoisted(() => ({ second: false }));
const SECOND_LANE_ID = "fake-lane-b";

vi.mock("../../lanes/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lanes/catalog")>();
  return {
    ...actual,
    getLaneCatalog: () => ({
      ok: true,
      catalog: lanes.second
        ? fakeLaneCatalogOf([
            { id: FAKE_LANE_ID, adapter: FAKE_HARNESS_ID, label: "Fake harness" },
            { id: SECOND_LANE_ID, adapter: FAKE_HARNESS_ID, label: "Fake harness (B)" },
          ])
        : fakeLaneCatalog(),
    }),
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

function queuedTasks() {
  return testDb
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.runId, runId))
    .all()
    .filter((t) => t.status === "queued");
}

function feed(): string[] {
  return testDb
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.taskId, taskId))
    .all()
    .map((m) => {
      try {
        return JSON.parse(m.content).text as string;
      } catch {
        return m.content;
      }
    });
}

describe("a whole turn through the turn manager on the fake adapter (issue #214)", () => {
  let turns: TurnManager;
  let fake: FakeHarness;
  let unregister: () => void;
  let config: typeof import("@/lib/config");
  const env = { ...process.env };

  beforeEach(async () => {
    testDb = createTestDb().db;
    docker.calls.length = 0;
    github.comments.length = 0;
    github.prReady.length = 0;
    lanes.second = false;
    // The fake lane's credential, so it resolves as available. A value, never
    // a real token. No explicit lane choice, so the catalog's preference — the
    // fake lane — is the primary.
    process.env[FAKE_LANE_AUTH_VAR] = "fake-token";
    delete process.env.AGENT_LANE;
    delete process.env.AGENT_MODEL;
    delete process.env.TURN_WALL_CLOCK_MINUTES;
    vi.resetModules();
    config = await import("@/lib/config");
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

  it("takes the ordinary path on a refused { other }, exactly as before the vocabulary existed", async () => {
    // A provider that said no for a reason the fleet does not model is neither
    // a wall nor a lane failure: the pass had left a PR behind, so it finishes
    // like any other implement pass.
    fake.script(
      scriptedTurn(
        { kind: "refused", refusal: { kind: "other", resumeAfter: null, limitType: null } },
        { finalMessage: "529 Overloaded" }
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

  describe("refusals and turn bounds on a harness with no rate-limit event and no CLI ceiling (issue #220)", () => {
    /** The shape such a harness produces at a wall: it knows the account
     * refused it for quota, and names neither a window nor a reset. */
    const WALL_WITHOUT_CLOCK = {
      kind: "refused" as const,
      refusal: { kind: "quota" as const, resumeAfter: null, limitType: null },
    };

    it("moves the run to another lane that can serve it, ahead of parking", async () => {
      // The wall ordering's middle step, through the fake adapter: an
      // account-wide wall on lane A, with lane B declared on the same fake
      // adapter and available, moves the run rather than parking it.
      lanes.second = true;
      fake.script(
        scriptedTurn({
          kind: "refused",
          refusal: { kind: "quota", resumeAfter: RESUME_AFTER, limitType: "five_hour" },
        })
      );

      await turns.startTask(taskId);

      expect(task().lane).toBe(FAKE_LANE_ID);
      expect(run().status).toBe("implementing");
      expect(run().resumeAfter).toBeNull();
      // A move is a continuation of the attempt, counted where a resume is
      // (issue #169) and spending neither an attempt nor an interruption.
      expect(run().resumeCount).toBe(1);
      expect(run().attempt).toBe(1);
      expect(run().interruptionCount).toBe(0);
      const queued = queuedTasks();
      expect(queued).toHaveLength(1);
      expect(queued[0].resumedFromTaskId).toBe(taskId);
      expect(queued[0].kind).toBe("implement");
      expect(docker.calls).toEqual([
        "createWorkspaceContainer",
        "execAgentTurn",
        "push",
        "removeContainer",
      ]);
      expect(github.comments.some((c) => c.includes("Moved execution lane"))).toBe(true);
      expect(github.comments.some((c) => c.includes("Fake harness (B)"))).toBe(true);
    });

    it("parks a refusal that named no reset time on the default backoff, with nowhere to move", async () => {
      // Before #220 this refusal — no tier to step down, no lane to move to,
      // no clock to wait on — took the ordinary path and spent an attempt.
      fake.script(scriptedTurn(WALL_WITHOUT_CLOCK, { finalMessage: null, costUsd: 0 }));

      const before = Date.now();
      await turns.startTask(taskId);
      const after = Date.now();

      expect(run().status).toBe("rate_limited");
      expect(run().attempt).toBe(1);
      expect(run().interruptionCount).toBe(0);
      expect(run().finishedAt).toBeNull();
      // The clock is the backoff named in the budgets module, from the moment
      // the pass was decided — not a reset the provider never stated.
      const resumeAfter = run().resumeAfter!.getTime();
      expect(resumeAfter).toBeGreaterThanOrEqual(before + DEFAULT_REFUSAL_BACKOFF_MS);
      expect(resumeAfter).toBeLessThanOrEqual(after + DEFAULT_REFUSAL_BACKOFF_MS);
      expect(task().status).toBe("failed");
      expect(docker.calls).toEqual([
        "createWorkspaceContainer",
        "execAgentTurn",
        "push",
        "removeContainer",
      ]);
      // Said as a wait, not a reset, in both places a human reads it.
      const comment = github.comments.find((c) => c.includes("Run paused"));
      expect(comment).toContain("named no reset time");
      expect(comment).toContain("default backoff");
      expect(feed().some((m) => m.includes("default backoff"))).toBe(true);
    });

    it("ends a pass whose credential was refused: the lane is unavailable for the run and nothing retries on it", async () => {
      // Not a wall. The pass never reached the model, so the run does not
      // spend an attempt on it — it takes the bounded interruption path an
      // unavailable lane at pass start takes — and no retry, resume or move is
      // queued under the run.
      fake.script(
        scriptedTurn(
          { kind: "refused", refusal: { kind: "auth", resumeAfter: null, limitType: null } },
          { finalMessage: "401 Unauthorized" }
        )
      );

      await turns.startTask(taskId);

      expect(run().status).toBe("interrupted");
      expect(run().interruptionCount).toBe(1);
      expect(run().attempt).toBe(1);
      expect(run().resumeAfter).toBeNull();
      expect(run().resumeCount).toBe(0);
      // Marked unavailable for the run in the resolver's own words, naming the
      // orchestrator variable an operator would rotate.
      expect(run().failureReason).toContain(`execution lane "${FAKE_LANE_ID}" is unavailable`);
      expect(run().failureReason).toContain("refused its credential");
      expect(run().failureReason).toContain(FAKE_LANE_AUTH_VAR);
      expect(task().status).toBe("failed");
      expect(queuedTasks()).toEqual([]);
      expect(fake.execs).toHaveLength(1);
      expect(docker.calls).toEqual([
        "createWorkspaceContainer",
        "execAgentTurn",
        "push",
        "removeContainer",
      ]);
      const comment = github.comments.find((c) => c.includes("refused this pass's credential"));
      expect(comment).toContain(FAKE_LANE_ID);
      expect(comment).toContain(FAKE_LANE_AUTH_VAR);
      expect(comment).toContain("no attempt was consumed");
      expect(feed().some((m) => m.startsWith("Lane unavailable"))).toBe(true);
    });

    it("ends a turn past the wall-clock ceiling as a turn limit, stopping the exec, and the attempt fails as a turn-limited turn does", async () => {
      // The harness never reports done and its stream never closes — the shape
      // of a hung process. Only the orchestrator's own ceiling can end it, and
      // it must end it as a turn limit: a null outcome after the stop would
      // read as an interruption and re-claim the ticket forever.
      process.env.TURN_WALL_CLOCK_MINUTES = "0.002"; // 120 ms
      config.resetConfig();
      fake.script(hangingTurn(scriptedTurn(null, { finalMessage: null, costUsd: 0 })));

      await turns.startTask(taskId);

      expect(run().status).toBe("failed");
      expect(run().failureReason).toContain("turn limit reached");
      expect(run().interruptionCount).toBe(0);
      expect(task().status).toBe("failed");
      // The exec was stopped, before the container went.
      expect(docker.calls).toEqual([
        "createWorkspaceContainer",
        "execAgentTurn",
        "stopAgentTurn",
        "push",
        "removeContainer",
      ]);
      expect(feed().some((m) => m.includes("wall-clock ceiling"))).toBe(true);
      expect(fake.pending()).toBe(0);
    });
  });
});
