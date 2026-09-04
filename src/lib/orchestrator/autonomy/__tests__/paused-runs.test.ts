import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/create-test-db";
import * as schema from "@/db/schema";
import { newId } from "@/lib/ulid";
import { resetConfig } from "@/lib/config";
import { resetLaneCatalog } from "@/lib/lanes/catalog";
import { describeLaneCost } from "@/lib/lanes/lane-rate";

/**
 * What the sweep knows about a run parked on the quota clock, and what a
 * resume writes (issues #169, #199), driven over a real (in-memory, migrated)
 * database with the real `lanes.yaml` — the sibling of `lane-failover.test.ts`,
 * which drives the same ranking through the turn manager at the moment of the
 * wall. This drives it from the sweep's side, minutes or hours later.
 *
 * The reducer's table tests say what is *decided* from a paused run's facts;
 * these say what the facts *are* — that a paid lane authorised after the pause
 * is offered at the next gather, and that a lane the money guards hold is not
 * — and what the two resumes write to the ledger, which is where "counts
 * against the same bound", "carries the session" and "announced with the lane
 * and its cost" are observable.
 *
 * Only outbound I/O is stubbed (GitHub, the transcript store). The DB reads
 * and writes, the ranking and the real lane file are the real thing.
 */

let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const github = vi.hoisted(() => ({ comments: [] as string[] }));

vi.mock("../../../github/issues", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../github/issues")>();
  return {
    ...actual,
    commentOnIssue: async (_ref: string, body: string) => {
      github.comments.push(body);
      return undefined;
    },
  };
});

/** Whether the paused pass's conversation is on disk — the switch that decides
 * if a resumed pass may carry `--resume`. */
const transcript = vi.hoisted(() => ({ survives: true }));

vi.mock("../../../quota/session-transcript", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../quota/session-transcript")>();
  return {
    ...actual,
    hasTranscript: () => transcript.survives,
  };
});

type PausedRuns = typeof import("../paused-runs");
type MoneyState = typeof import("../../../lanes/money-state");
type Settings = typeof import("../../../settings");
type QuotaStore = typeof import("../../../quota/quota-store");

const ISSUE_REF = "lennons301/lemons#34";
const NOW = new Date("2026-09-04T10:00:00.000Z");
/** Four hours out: the wall stands. */
const RESUME_AFTER = new Date(NOW.getTime() + 4 * 60 * 60_000);
const PROMPT = "Implement issue #34 — add the frobnicator.";
const SESSION = "sess-abcdef";

let projectId: string;
let runId: string;
let taskId: string;

/** A run #168 parked an hour ago: `rate_limited` on the subscription lane's
 * five-hour window, its implement pass failed and its container gone, one
 * interruption already recorded so a resume that touched the wrong counter
 * would show. */
function seedPausedRun(): void {
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
      status: "rate_limited",
      resumeAfter: RESUME_AFTER,
      budgetUsd: 20,
      model: "light",
      lane: "claude-subscription",
      laneBilling: "subscription",
      interruptionCount: 1,
      claimedAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
      startedAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
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
      status: "failed",
      kind: "implement",
      runId,
      githubIssue: ISSUE_REF,
      branch: "agent/issue-34",
      sessionId: SESSION,
      lane: "claude-subscription",
      laneBilling: "subscription",
      pullRequestNumber: 35,
      pullRequestUrl: "https://github.com/lennons301/lemons/pull/35",
      createdAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
      updatedAt: new Date(NOW.getTime() - 60 * 60_000),
    })
    .run();
}

/** The fleet settings row, written directly — an absent row is how a fresh
 * install reads, so a test that needs a confirmation or an override writes
 * one. */
function writeSettings(fields: {
  overrides?: Record<string, string>;
  meteredSpendConfirmedAt?: Date | null;
}): void {
  const values = {
    id: "fleet",
    overrides: fields.overrides ?? { maxResumesPerAttempt: "3" },
    meteredSpendConfirmedAt:
      fields.meteredSpendConfirmedAt === undefined ? NOW : fields.meteredSpendConfirmedAt,
    updatedAt: NOW,
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

function queuedTasks() {
  return testDb
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.status, "queued"))
    .all();
}

describe("a run parked on the quota clock (issues #169, #199)", () => {
  let pausedRuns: PausedRuns;
  let moneyState: MoneyState;
  let settingsModule: Settings;
  const savedEnv = { ...process.env };

  /** The sweep's own reads for one tick, in the order it makes them. */
  function gather() {
    const settings = settingsModule.getFleetSettings();
    const allRuns = testDb.select().from(schema.runs).all();
    return pausedRuns.gatherPausedRuns(
      allRuns,
      NOW,
      settings,
      moneyState.readMoneyGuards(NOW, settings)
    );
  }

  beforeEach(async () => {
    testDb = createTestDb().db;
    github.comments.length = 0;
    transcript.survives = true;

    // The real `lanes.yaml` is read, so the credentials its lanes name decide
    // what is available: the subscription (walled below) and OpenRouter.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth";
    process.env.OPENROUTER_API_KEY = "sk-or";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.AGENT_LANE;
    delete process.env.AGENT_MIN_LANE;
    delete process.env.AGENT_MODEL;
    resetConfig();
    resetLaneCatalog();

    vi.resetModules();
    pausedRuns = await import("../paused-runs");
    moneyState = await import("../../../lanes/money-state");
    settingsModule = await import("../../../settings");
    const quotaStore: QuotaStore = await import("../../../quota/quota-store");

    seedPausedRun();
    // The wall the pause left behind: the subscription lane's row says
    // `rejected` until the window resets, exactly as the stream parser wrote
    // it at the moment of the refusal (#167).
    quotaStore.recordQuotaObservation("claude-subscription", {
      status: "rejected",
      rateLimitType: "five_hour",
      utilization: null,
      resetsAt: RESUME_AFTER,
      overageStatus: null,
      overageResetsAt: null,
      isUsingOverage: false,
      overageInUse: null,
      observedAt: new Date(NOW.getTime() - 60 * 60_000),
    });
    // Three continuations allowed and the day's cash confirmed, so neither the
    // bound nor #174's press is the thing under test unless a case says so.
    writeSettings({});
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    resetConfig();
    resetLaneCatalog();
    vi.restoreAllMocks();
  });

  describe("what the sweep gathers", () => {
    it("reports the run's clock, its spent resumes and the lane that walled it", () => {
      const [paused] = gather();

      expect(paused).toMatchObject({
        runId,
        issueRef: ISSUE_REF,
        resumeAfter: RESUME_AFTER,
        resumesMade: 0,
        hasLiveTask: false,
        laneId: "claude-subscription",
      });
    });

    it("offers the cheapest permitted lane other than the walled one", () => {
      const [paused] = gather();

      // GLM is the cheapest priced lane; the subscription is excluded as the
      // lane that refused the pass, whatever its row says.
      expect(paused.laneFailover).toMatchObject({
        toLaneId: "openrouter-glm",
        toLaneLabel: "OpenRouter (GLM open weights)",
        billing: "metered",
      });
      expect(paused.laneFailover?.rateUsdPerMTok).toBeGreaterThan(0);
    });

    it("offers nothing while the day's real money is unconfirmed, and offers it once confirmed", () => {
      // The ticket's central promise. #174's confirm-once press is not waived
      // by a wall — unattended work never starts spending cash on its own — and
      // a press made after the pause takes effect at the *next gather*, not at
      // the end of the window.
      writeSettings({ meteredSpendConfirmedAt: null });
      expect(gather()[0].laneFailover).toBeNull();

      writeSettings({ meteredSpendConfirmedAt: NOW });
      expect(gather()[0].laneFailover?.toLaneId).toBe("openrouter-glm");
    });

    it("offers nothing once the real-money cap for the day is spent", async () => {
      const { recordMeteredSpend } = await import("../../spend");
      recordMeteredSpend(0, 20, NOW);

      expect(gather()[0].laneFailover).toBeNull();
    });

    it("offers nothing when no other lane has a credential", () => {
      delete process.env.OPENROUTER_API_KEY;
      resetConfig();

      // A missing credential is #172's report, never something to route
      // around: the run stays parked on its clock.
      expect(gather()[0].laneFailover).toBeNull();
    });

    it("offers nothing when the pass kind's minimum lane excludes every other lane", () => {
      writeSettings({
        overrides: { maxResumesPerAttempt: "3", minLaneImplement: "anthropic-api" },
      });

      expect(gather()[0].laneFailover).toBeNull();
    });

    it("still offers a lane when the fleet is pinned to the one that walled it", () => {
      // A pin turns cost routing off while the pinned lane can serve the work;
      // a wall releases it, exactly as it does for a failover at the moment of
      // the refusal (#176).
      writeSettings({
        overrides: { maxResumesPerAttempt: "3", primaryLane: "claude-subscription" },
      });

      expect(gather()[0].laneFailover?.toLaneId).toBe("openrouter-glm");
    });

    it("honours a pin to a third lane, which a wall on the walled one does not release", () => {
      // The operator's explicit choice names a lane that can serve the work,
      // so cost routing stays off (#172): the pinned lane is the only
      // candidate, even though GLM is cheaper.
      writeSettings({
        overrides: { maxResumesPerAttempt: "3", primaryLane: "openrouter" },
      });

      expect(gather()[0].laneFailover?.toLaneId).toBe("openrouter");
    });

    it("ranks at the tier the run actually runs at", () => {
      // A run #170 stepped down to `light` is priced off each lane's light
      // row — so the figure the announcement quotes is the one the resumed
      // pass would be charged from.
      const light = gather()[0].laneFailover?.rateUsdPerMTok ?? null;
      testDb.update(schema.runs).set({ model: "heavy" }).where(eq(schema.runs.id, runId)).run();
      const heavy = gather()[0].laneFailover?.rateUsdPerMTok ?? null;

      expect(light).not.toBeNull();
      expect(heavy).not.toBeNull();
      expect(heavy!).toBeGreaterThan(light!);
    });

    it("does not rank a run that is already resuming", () => {
      testDb
        .insert(schema.tasks)
        .values({
          id: newId(),
          projectId,
          title: "Add the frobnicator",
          description: PROMPT,
          status: "queued",
          kind: "implement",
          runId,
          githubIssue: ISSUE_REF,
          branch: "agent/issue-34",
          createdAt: NOW,
          updatedAt: NOW,
        })
        .run();

      const [paused] = gather();

      expect(paused.hasLiveTask).toBe(true);
      expect(paused.laneFailover).toBeNull();
    });

    it("gathers nothing when no run is paused", () => {
      testDb
        .update(schema.runs)
        .set({ status: "implementing", resumeAfter: null })
        .where(eq(schema.runs.id, runId))
        .run();

      expect(gather()).toEqual([]);
    });
  });

  describe("resuming early on another lane", () => {
    const action = () =>
      ({
        type: "resumeRunOnLane",
        runId,
        issueRef: ISSUE_REF,
        fromLaneId: "claude-subscription",
        toLaneId: "openrouter-glm",
        toLaneLabel: "OpenRouter (GLM open weights)",
        toLaneBilling: "metered",
        toLaneRateUsdPerMTok: 0.03875,
        resumeAfter: RESUME_AFTER,
        resume: 1,
        maxResumes: 3,
      }) as const;

    it("queues the paused pass again, on the same branch, behind the move's preamble", async () => {
      await pausedRuns.executeResumeRunOnLane(action());

      const queued = queuedTasks();
      expect(queued).toHaveLength(1);
      const [resumed] = queued;
      expect(resumed.runId).toBe(runId);
      expect(resumed.kind).toBe("implement");
      expect(resumed.branch).toBe("agent/issue-34");
      expect(resumed.githubIssue).toBe(ISSUE_REF);
      expect(resumed.pullRequestNumber).toBe(35);
      // The brief rides across verbatim behind the lane move's own preamble.
      expect(resumed.description).toContain(PROMPT);
      expect(resumed.description).toContain("continuing on OpenRouter (GLM open weights)");
      // The lineage that carries the attempt's budget across the resume.
      expect(resumed.resumedFromTaskId).toBe(taskId);
    });

    it("carries the session, so the move is lossless the way a resume is", async () => {
      await pausedRuns.executeResumeRunOnLane(action());

      expect(queuedTasks()[0].sessionId).toBe(SESSION);
      expect(github.comments.join("\n")).toContain("continues the same conversation");
    });

    it("drops the session when its transcript is not on disk", async () => {
      transcript.survives = false;

      await pausedRuns.executeResumeRunOnLane(action());

      expect(queuedTasks()[0].sessionId).toBeNull();
      expect(github.comments.join("\n")).toContain("could not be preserved");
    });

    it("counts against the resume bound and nothing else", async () => {
      await pausedRuns.executeResumeRunOnLane(action());

      expect(run().resumeCount).toBe(1);
      expect(run().attempt).toBe(2);
      expect(run().interruptionCount).toBe(1);
    });

    it("leaves the run visibly paused until the pass actually starts", async () => {
      await pausedRuns.executeResumeRunOnLane(action());

      expect(run().status).toBe("rate_limited");
      expect(run().resumeAfter?.getTime()).toBe(RESUME_AFTER.getTime());
    });

    it("announces the lane and what it costs on the issue", async () => {
      await pausedRuns.executeResumeRunOnLane(action());

      const comment = github.comments.join("\n");
      expect(comment).toContain("Resumed early on another lane");
      expect(comment).toContain("OpenRouter (GLM open weights)");
      expect(comment).toContain("claude-subscription");
      expect(comment).toContain("does not reset until");
      expect(comment).toContain("$0.039 per million tokens");
      expect(comment).toContain("real-money cap");
      expect(comment).toContain("resume 1/3");
      expect(comment).toContain("neither an attempt nor an interruption");
    });

    it("says so when the target lane declares no prices, or costs nothing", async () => {
      await pausedRuns.executeResumeRunOnLane({
        ...action(),
        toLaneId: "anthropic-api",
        toLaneLabel: "Anthropic API",
        toLaneRateUsdPerMTok: null,
      });
      expect(github.comments.at(-1)).toContain("declares no prices");

      expect(describeLaneCost("subscription", null)).toContain(
        "costs nothing at the margin"
      );
    });

    it("queues nothing for a run already resuming", async () => {
      await pausedRuns.executeResumeRunOnLane(action());
      await pausedRuns.executeResumeRunOnLane({ ...action(), resume: 2 });

      // Two sweeps can be in flight at once (#159); the second decision is
      // stale, not a second container.
      expect(queuedTasks()).toHaveLength(1);
      expect(run().resumeCount).toBe(1);
      expect(github.comments).toHaveLength(1);
    });

    it("leaves a run whose status has moved on alone", async () => {
      testDb
        .update(schema.runs)
        .set({ status: "cancelled", resumeAfter: null })
        .where(eq(schema.runs.id, runId))
        .run();

      await pausedRuns.executeResumeRunOnLane(action());

      expect(queuedTasks()).toEqual([]);
      expect(github.comments).toEqual([]);
    });
  });

  describe("resuming once the window has reset", () => {
    it("queues the paused pass behind the resume's preamble and counts it", async () => {
      await pausedRuns.executeResumeRun({
        type: "resumeRun",
        runId,
        issueRef: ISSUE_REF,
        resume: 1,
        maxResumes: 3,
      });

      const [resumed] = queuedTasks();
      expect(resumed.description).toContain(PROMPT);
      expect(resumed.description).toContain("the window has now reset");
      expect(resumed.sessionId).toBe(SESSION);
      expect(resumed.resumedFromTaskId).toBe(taskId);
      expect(run().resumeCount).toBe(1);
      expect(run().status).toBe("rate_limited");
      expect(github.comments.join("\n")).toContain("The quota window has reset");
    });
  });
});
