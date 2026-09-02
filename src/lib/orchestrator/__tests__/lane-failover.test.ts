import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/create-test-db";
import * as schema from "@/db/schema";
import { newId } from "@/lib/ulid";
import { resetConfig } from "@/lib/config";
import { resetLaneCatalog } from "@/lib/lanes/catalog";

/**
 * What a quota wall its own lane cannot get past does to the run ledger
 * (issue #176), driven through the real pass-completion seam over a real
 * (in-memory, migrated) database — the third sibling of `quota-pause.test.ts`
 * (the account-wide wall that stops a run) and `quota-degrade.test.ts` (the
 * tier-scoped one that steps it down a rung).
 *
 * The reducer's table tests say what is *decided*; these say what is
 * *written*, which is where this ticket's promises live and where none of them
 * are observable from the reducer: the run moves lanes and retries rather than
 * parking (a fresh queued pass exists), the retry **carries the session** so
 * the move is lossless, the move counts against the resume bound, and none of
 * it costs an attempt or an interruption.
 *
 * It also exercises the one thing the pure ranking cannot: that the impure
 * gatherer reads the *real* `lanes.yaml`, the real settings row and the real
 * money ledger, so the lane a refused pass is offered is one this deployment
 * could actually run.
 *
 * Only outbound I/O is stubbed (Docker, GitHub). The DB writes, their
 * ordering, the ranking and the container teardown are the real thing.
 */

let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const docker = vi.hoisted(() => ({ calls: [] as string[] }));

/** Whether the refused pass's conversation survives its container's teardown
 * — the switch both mocks below read. */
const transcript = vi.hoisted(() => ({ survives: true }));

vi.mock("../../docker/container-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../docker/container-manager")>();
  return {
    ...actual,
    observeContainerAbsent: async () => false,
    startContainer: async () => docker.calls.push("startContainer"),
    stopContainer: async () => docker.calls.push("stopContainer"),
    removeContainer: async () => docker.calls.push("removeContainer"),
    execFallbackCommitAndPush: async () => docker.calls.push("push"),
    // The refused pass's conversation, read out of the container that is about
    // to go (#169's mechanism, which #176 reuses). Stubbed to a switch this
    // test can flip, because whether it landed is precisely what decides if
    // the retry may carry `--resume`.
    readContainerFile: async () =>
      transcript.survives ? '{"type":"user"}\n' : null,
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

/** Writing the transcript is real disk I/O beside the database; stubbed so the
 * test asserts what the ledger does with the answer rather than exercising the
 * filesystem, which `session-transcript.test.ts` already owns. */
vi.mock("../../quota/session-transcript", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../quota/session-transcript")>();
  return {
    ...actual,
    saveTranscript: () => transcript.survives,
    hasTranscript: () => transcript.survives,
  };
});

type TurnManager = typeof import("../turn-manager");

const ISSUE_REF = "lennons301/lemons#34";
const RESETS_AT_EPOCH = 1788310954;
const RESUME_AFTER = new Date(RESETS_AT_EPOCH * 1000);
const PROMPT = "Implement issue #34 — add the frobnicator.";
const SESSION = "sess-abcdef";

/** The turn the CLI hands back at an **account-wide** wall: the exit says
 * `subtype: "success"` (#165's finding), and only the rate-limit event beside
 * it names the window. */
function walledOn(rateLimitType: string, resetsAt: Date | null = RESUME_AFTER) {
  return {
    finalMessage: "You've hit your 5-hour limit · resets at 14:05",
    terminalResult: {
      type: "result",
      subtype: "success",
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: 429,
      total_cost_usd: 0,
    } as Record<string, unknown>,
    rateLimit: {
      status: "rejected",
      rateLimitType,
      utilization: null,
      resetsAt,
      overageStatus: null,
      overageResetsAt: null,
      isUsingOverage: false,
      overageInUse: null,
      observedAt: new Date("2026-09-01T12:00:00.000Z"),
    },
  };
}

let projectId: string;
let runId: string;
let taskId: string;

/** An implement pass mid-attempt at the bottom of the tier ladder, so the step
 * down (#170) has nowhere to go and the lane move is what is left. Attempt 2
 * of 3 with one interruption already recorded, so both counters would be
 * visibly wrong if a move touched them. */
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
      attempt: 2,
      mode: "autonomous",
      status: "implementing",
      budgetUsd: 20,
      model: "light",
      lane: "claude-subscription",
      laneBilling: "subscription",
      interruptionCount: 1,
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
      description: PROMPT,
      status: "running",
      kind: "implement",
      runId,
      githubIssue: ISSUE_REF,
      branch: "agent/issue-34",
      sessionId: SESSION,
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

/**
 * The fleet settings row, written directly. Nothing seeds it — an absent row is
 * how a fresh install reads as "everything falls through" — so a test that
 * needs an override or the day's confirmation upserts it.
 */
function writeSettings(fields: {
  overrides?: Record<string, string>;
  meteredSpendConfirmedAt?: Date | null;
}): void {
  const values = {
    id: "fleet",
    overrides: fields.overrides ?? { maxResumesPerAttempt: "2" },
    meteredSpendConfirmedAt:
      fields.meteredSpendConfirmedAt === undefined
        ? new Date()
        : fields.meteredSpendConfirmedAt,
    updatedAt: new Date(),
  };
  testDb
    .insert(schema.settings)
    .values(values)
    .onConflictDoUpdate({ target: schema.settings.id, set: values })
    .run();
}

function run() {
  return testDb.select().from(schema.runs).where(eq(schema.runs.id, runId)).get()!;
}

function retryTasks() {
  return testDb
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.status, "queued"))
    .all();
}

function systemMessages(): string[] {
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

describe("an implement pass refused on a wall its lane cannot get past (issue #176)", () => {
  let turns: TurnManager;
  const savedEnv = { ...process.env };

  async function boot() {
    testDb = createTestDb().db;
    docker.calls.length = 0;
    github.comments.length = 0;
    transcript.survives = true;

    // The real `lanes.yaml` is read, so the credentials its lanes name decide
    // what is available — which is the point: the lane a refused pass is
    // offered has to be one this deployment could run.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth";
    process.env.OPENROUTER_API_KEY = "sk-or";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.AGENT_LANE;
    delete process.env.AGENT_MIN_LANE;
    delete process.env.AGENT_MODEL;
    resetConfig();
    resetLaneCatalog();

    vi.resetModules();
    turns = await import("../turn-manager");
    turns.getActiveTasks().clear();
    seedImplementPass();
    // Two continuations allowed and the day's cash confirmed, so neither the
    // bound nor #174's press is the thing under test unless a case says so.
    writeSettings({});
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
  }

  beforeEach(async () => {
    await boot();
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    resetConfig();
    resetLaneCatalog();
    vi.restoreAllMocks();
  });

  it("moves the run onto the cheapest permitted lane and keeps it running", async () => {
    const decision = await turns.evaluatePassOutcome(taskId, walledOn("five_hour"));

    expect(decision).toBe("failed-over");
    // Emphatically not the pause: `rate_limited` would sit this run out for up
    // to five hours beside a lane that can run the work now.
    expect(run().status).toBe("implementing");
    expect(run().resumeAfter).toBeNull();
    expect(run().finishedAt).toBeNull();
    expect(run().failureReason).toBeNull();
  });

  it("queues a fresh pass of the same kind, carrying the same work", async () => {
    await turns.evaluatePassOutcome(taskId, walledOn("five_hour"));

    const retries = retryTasks();
    expect(retries).toHaveLength(1);
    const retry = retries[0];
    expect(retry.runId).toBe(runId);
    expect(retry.kind).toBe("implement");
    expect(retry.branch).toBe("agent/issue-34");
    expect(retry.githubIssue).toBe(ISSUE_REF);
    // The brief rides across verbatim behind the move's preamble — the work
    // has not changed, only who is running it.
    expect(retry.description).toContain(PROMPT);
    expect(retry.description).toContain("continuing on");
    // The lineage that carries the attempt's budget across the move, so one
    // attempt cannot be handed its whole allowance twice (#169, #170).
    expect(retry.resumedFromTaskId).toBe(taskId);
  });

  it("carries the session, so the move is lossless the way a resume is", async () => {
    await turns.evaluatePassOutcome(taskId, walledOn("five_hour"));

    expect(retryTasks()[0].sessionId).toBe(SESSION);
    expect(systemMessages().at(-1)).toContain("continues this conversation");
  });

  it("drops the session when its transcript did not survive the teardown", async () => {
    // `--resume` against a session the fresh container has never heard of
    // fails the pass outright, where the declared fallback is a pass that
    // starts again on the same branch with the work pushed.
    transcript.survives = false;

    await turns.evaluatePassOutcome(taskId, walledOn("five_hour"));

    expect(retryTasks()[0].sessionId).toBeNull();
    expect(systemMessages().at(-1)).toContain("could not be copied out");
  });

  it("counts the move against the resume bound and nothing else", async () => {
    await turns.evaluatePassOutcome(taskId, walledOn("five_hour"));

    // The same counter a resume answers to (#169) — which is what stops a run
    // walking its lanes forever without a second number to keep true.
    expect(run().resumeCount).toBe(1);
    // The two bounds that measure something else keep measuring it: the work
    // was never tried, and the platform did not die.
    expect(run().attempt).toBe(2);
    expect(run().interruptionCount).toBe(1);
  });

  it("removes the refused pass's container rather than parking it", async () => {
    // A parked container holds ~2 GiB while holding no slot, which is what
    // wedged the host on 2026-08-04, and nothing comes back to this one: the
    // branch was pushed after the turn.
    await turns.evaluatePassOutcome(taskId, walledOn("five_hour"));

    expect(docker.calls).toContain("removeContainer");
    expect(docker.calls).not.toContain("stopContainer");
  });

  it("says so on the issue, naming the lane and the move's own runway", async () => {
    await turns.evaluatePassOutcome(taskId, walledOn("five_hour"));

    const comment = github.comments.join("\n");
    expect(comment).toContain("Moved execution lane");
    expect(comment).toContain("OpenRouter");
    expect(comment).toContain("move 1/2");
    expect(comment).toContain("neither an attempt nor an interruption");
  });

  it("moves on a reset-less wall, which could not pause and used to cost an attempt", async () => {
    const decision = await turns.evaluatePassOutcome(
      taskId,
      walledOn("five_hour", null)
    );

    expect(decision).toBe("failed-over");
    expect(retryTasks()).toHaveLength(1);
    expect(run().attempt).toBe(2);
  });

  it("pauses instead when the day's real money is unconfirmed", async () => {
    // #174's confirm-once press is not waived by a wall: an autonomous move
    // onto a paid lane is *allowed*, bounded by that gate, never exempt from
    // it. With nowhere permitted to go, #168's pause is what happens.
    writeSettings({ meteredSpendConfirmedAt: null });

    const decision = await turns.evaluatePassOutcome(taskId, walledOn("five_hour"));

    expect(decision).toBe("paused");
    expect(run().status).toBe("rate_limited");
    expect(run().resumeAfter?.getTime()).toBe(RESUME_AFTER.getTime());
    expect(retryTasks()).toHaveLength(0);
  });

  it("pauses instead when the real-money cap for the day is spent", async () => {
    const { recordMeteredSpend } = await import("../spend");
    recordMeteredSpend(0, 20);

    const decision = await turns.evaluatePassOutcome(taskId, walledOn("five_hour"));

    expect(decision).toBe("paused");
    expect(run().status).toBe("rate_limited");
  });

  it("pauses instead when the pass kind's minimum lane excludes every target", async () => {
    // The floor is an operator's own setting, and it holds against a wall: a
    // ticket floored at first-party Claude waits rather than being run by an
    // open-weights model.
    writeSettings({
      overrides: { maxResumesPerAttempt: "2", minLaneImplement: "anthropic-api" },
    });

    const decision = await turns.evaluatePassOutcome(taskId, walledOn("five_hour"));

    expect(decision).toBe("paused");
    expect(retryTasks()).toHaveLength(0);
  });

  it("still moves when the fleet is pinned to the lane that refused it", async () => {
    // The pin turns cost *routing* off — nothing chooses a lane while the
    // pinned one can serve the work — but it is released by a wall, because a
    // lane that cannot serve the request at all is a different thing from one
    // the operator would rather not use. #173 crossed an attended session off
    // a pinned walled lane too, and that keeps being true.
    writeSettings({
      overrides: {
        maxResumesPerAttempt: "2",
        primaryLane: "claude-subscription",
      },
    });

    const decision = await turns.evaluatePassOutcome(taskId, walledOn("five_hour"));

    expect(decision).toBe("failed-over");
    expect(retryTasks()).toHaveLength(1);
  });


  it("pauses instead once the attempt's continuations are spent", async () => {
    testDb
      .update(schema.runs)
      .set({ resumeCount: 2 })
      .where(eq(schema.runs.id, runId))
      .run();

    const decision = await turns.evaluatePassOutcome(taskId, walledOn("five_hour"));

    expect(decision).toBe("paused");
    expect(retryTasks()).toHaveLength(0);
  });

  it("steps the tier ladder first, where the account still has quota", async () => {
    // #170's step is within the lane and costs nothing, so it is asked before
    // a move that may cost real money. This run is at the bottom of the ladder
    // above; give it a rung to step to and the move must not fire.
    testDb
      .update(schema.runs)
      .set({ model: "heavy" })
      .where(eq(schema.runs.id, runId))
      .run();

    const decision = await turns.evaluatePassOutcome(
      taskId,
      walledOn("seven_day_opus")
    );

    expect(decision).toBe("degraded");
    expect(run().resumeCount).toBe(0);
  });
});
