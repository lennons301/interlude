import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/create-test-db";
import * as schema from "@/db/schema";
import { newId } from "@/lib/ulid";

/**
 * A repair pass runs at the run's own implement tier (issue #211) — no step,
 * no derivation — and leaves that tier where it found it (issue #201). Driven
 * through the real `startTask` over a real (in-memory, migrated) database and
 * the real `lanes.yaml`, up to the container — which is stubbed to fail,
 * because everything these tickets promise about the ledger is written
 * *before* the container is provisioned.
 *
 * Two facts, both only observable here: the task row records the tier the
 * repair actually ran at, and `runs.model` — the tier the implement pass ran
 * at, what the review derives from, what the quota ladder steps off and what
 * outcome-by-tier groups the run under — is not rewritten by it. Writing it
 * back would be a no-op on a run that recorded a tier and a backfill on one
 * that did not, filing the run under a fleet default its repair happened to
 * resolve.
 */

let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

vi.mock("../../docker/container-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../docker/container-manager")>();
  return {
    ...actual,
    createWorkspaceContainer: async () => {
      throw new Error("no docker in this test");
    },
    removeContainer: async () => undefined,
    stopContainer: async () => undefined,
  };
});

vi.mock("../../github/issues", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../github/issues")>();
  return {
    ...actual,
    commentOnIssue: async () => undefined,
  };
});

vi.mock("../../discord/notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../discord/notifications")>();
  return {
    ...actual,
    notifyTaskFailed: async () => null,
    notifyRunBlocked: async () => null,
  };
});

type TurnManager = typeof import("../turn-manager");

const ISSUE_REF = "lennons301/lemons#34";

let runId: string;
let taskId: string;

/** A run whose implement pass ran at `model`, parked awaiting the repair the
 * sweep queued for its PR (issue #54). */
function seedRepairPass(model: string | null, kind: "repair" | "implement" = "repair"): void {
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
      status: kind === "repair" ? "gated" : "claimed",
      budgetUsd: 20,
      model,
      lane: "claude-subscription",
      // A harness the implement pass is *not* about to resolve on the real
      // lane file, so "left alone" is distinguishable from "rewritten to the
      // same value" (issue #223).
      harness: "codex",
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
      title: kind === "repair" ? "Repair PR #35" : "Add the frobnicator",
      description: "Merge main into the branch and fix what breaks.",
      status: "queued",
      kind,
      runId,
      githubIssue: ISSUE_REF,
      branch: "agent/issue-34",
      pullRequestNumber: 35,
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

describe("a repair pass and the run's implement tier (issues #201, #211)", () => {
  let turns: TurnManager;
  const env = { ...process.env };

  async function boot(
    model: string | null,
    kind: "repair" | "implement" = "repair",
    /** The fleet's own tier settings, as the environment supplies them. */
    fleet: { AGENT_MODEL?: string } = {}
  ) {
    testDb = createTestDb().db;
    // The primary lane's credential, so the pass resolves a lane rather than
    // failing before it reaches the ledger. A value, never a real token.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test";
    delete process.env.AGENT_MODEL;
    delete process.env.AGENT_MODEL_REVIEW;
    delete process.env.AGENT_LANE;
    if (fleet.AGENT_MODEL) process.env.AGENT_MODEL = fleet.AGENT_MODEL;
    vi.resetModules();
    const config = await import("@/lib/config");
    config.resetConfig();
    turns = await import("../turn-manager");
    turns.getActiveTasks().clear();
    seedRepairPass(model, kind);
  }

  afterEach(() => {
    process.env = { ...env };
    vi.restoreAllMocks();
  });

  it("runs at the run's implement tier, with no step, and records that on its own row", async () => {
    // A repair is the same attempt continuing after the default branch moved
    // under its PR, not work judged wrong (issue #211) — so a standard run's
    // conflict is fixed by the tier that wrote the code, not the heavy one.
    await boot("standard");

    await turns.startTask(taskId);

    expect(task().tier).toBe("standard");
  });

  it("leaves the run's implement tier where it found it", async () => {
    await boot("standard");

    await turns.startTask(taskId);

    // The container failed, so the task is failed — the ledger writes under
    // test all landed before that, and the one that must not have is this.
    expect(task().status).toBe("failed");
    expect(run().model).toBe("standard");
  });

  it("leaves the run's harness where it found it, and records its own on its row (issue #223)", async () => {
    // The run's harness is the implement pass's fact, like its tier: a repair
    // consumes no attempt and its changes are not what the verdict judged, so
    // a repair on another harness must not file the attempt under that vendor.
    // The harness it *did* run on is on its own task row, where its spend is
    // attributed.
    await boot("standard");

    await turns.startTask(taskId);

    expect(task().harness).toBe("claude-code");
    expect(run().harness).toBe("codex");
  });

  it("lets the run's tier outrank the fleet's implement tier, as it did for the implement pass", async () => {
    // The ticket declared light and the fleet's default is standard: the
    // repair runs light — the run's tier is the directive the implement pass
    // honoured, and the fleet default is what it outranked — and the run
    // still reads as the light run it was.
    await boot("light", "repair", { AGENT_MODEL: "standard" });

    await turns.startTask(taskId);

    expect(task().tier).toBe("light");
    expect(run().model).toBe("light");
  });

  it("reads the fleet's implement tier when the run recorded none, without writing it back", async () => {
    // Exactly what an implement pass with no ticket tier does — except that
    // the implement pass writes what it resolved to `runs.model` and a repair
    // never does, so a run that recorded no tier is not filed under the
    // default its repair happened to resolve.
    await boot(null, "repair", { AGENT_MODEL: "standard" });

    await turns.startTask(taskId);

    expect(task().tier).toBe("standard");
    expect(run().model).toBeNull();
  });

  it("still lets the implement pass write the tier it resolved", async () => {
    // The contrast: `runs.model` is the implement pass's to write — the
    // guard is on the repair alone.
    await boot(null, "implement", { AGENT_MODEL: "standard" });

    await turns.startTask(taskId);

    expect(run().model).toBe("standard");
    expect(task().tier).toBe("standard");
    // And the harness with it — the implement pass's to write (issue #223).
    expect(run().harness).toBe("claude-code");
    expect(task().harness).toBe("claude-code");
  });
});
