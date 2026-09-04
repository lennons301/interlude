import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/create-test-db";
import * as schema from "@/db/schema";

/**
 * The manual lane move's endpoint (issue #202) against a from-migrations DB
 * with the real `lanes.yaml`: what the fleet card calls before it offers the
 * press, and what the press then does. The route is thin on purpose — the
 * decision is the pure `decideManualLaneMove`, the move is the sweep's own
 * resume body — so what is checked here is the contract the card reads: a
 * `GET` that says what would happen, a `POST` that does it and answers with
 * what it did, a `409` carrying the refusal when the fleet's state refuses it,
 * and a `404` for a run that does not exist.
 */
let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const github = vi.hoisted(() => ({ comments: [] as string[] }));

vi.mock("@/lib/github/issues", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/github/issues")>();
  return {
    ...actual,
    commentOnIssue: async (_ref: string, body: string) => {
      github.comments.push(body);
      return undefined;
    },
  };
});

vi.mock("@/lib/quota/session-transcript", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/quota/session-transcript")>();
  return { ...actual, hasTranscript: () => true };
});

import { GET, POST } from "@/app/api/runs/[id]/lane-move/route";
import { resetConfig } from "@/lib/config";
import { resetLaneCatalog } from "@/lib/lanes/catalog";
import { recordQuotaObservation } from "@/lib/quota/quota-store";
import { newId } from "@/lib/ulid";

const NOW = new Date();
const RESUME_AFTER = new Date(NOW.getTime() + 4 * 60 * 60_000);
const ISSUE_REF = "lennons301/lemons#34";

let runId: string;

function seed(): void {
  const projectId = newId();
  testDb
    .insert(schema.projects)
    .values({ id: projectId, name: "lemons", createdAt: NOW })
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
      status: "rate_limited",
      resumeAfter: RESUME_AFTER,
      budgetUsd: 20,
      model: "light",
      lane: "claude-subscription",
      laneBilling: "subscription",
      claimedAt: NOW,
      startedAt: NOW,
    })
    .run();
  testDb
    .insert(schema.tasks)
    .values({
      id: newId(),
      projectId,
      title: "Add the frobnicator",
      description: "Implement issue #34.",
      status: "failed",
      kind: "implement",
      runId,
      githubIssue: ISSUE_REF,
      branch: "agent/issue-34",
      sessionId: "sess-1",
      lane: "claude-subscription",
      laneBilling: "subscription",
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  recordQuotaObservation("claude-subscription", {
    status: "rejected",
    rateLimitType: "five_hour",
    utilization: null,
    resetsAt: RESUME_AFTER,
    overageStatus: null,
    overageResetsAt: null,
    isUsingOverage: false,
    overageInUse: null,
    observedAt: NOW,
  });
}

function confirmToday(confirmed: boolean): void {
  const values = {
    id: "fleet",
    overrides: { maxResumesPerAttempt: "3" },
    meteredSpendConfirmedAt: confirmed ? NOW : null,
    updatedAt: NOW,
  };
  testDb
    .insert(schema.settings)
    .values(values)
    .onConflictDoUpdate({ target: schema.settings.id, set: values })
    .run();
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

const request = (id: string, method = "GET") =>
  new Request(`http://test/api/runs/${id}/lane-move`, { method });

const savedEnv = { ...process.env };

describe("GET/POST /api/runs/[id]/lane-move", () => {
  beforeEach(() => {
    testDb = createTestDb().db;
    github.comments.length = 0;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth";
    process.env.OPENROUTER_API_KEY = "sk-or";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.AGENT_LANE;
    delete process.env.AGENT_MIN_LANE;
    delete process.env.AGENT_MODEL;
    resetConfig();
    resetLaneCatalog();
    seed();
    confirmToday(true);
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    resetConfig();
    resetLaneCatalog();
  });

  it("says what a press would do: the lane, its cost and the continuation", async () => {
    const res = await GET(request(runId), params(runId));

    expect(res.status).toBe(200);
    const reading = await res.json();
    expect(reading.runId).toBe(runId);
    expect(reading.decision.ok).toBe(true);
    expect(reading.decision.offer).toMatchObject({
      toLaneId: "openrouter-glm",
      billing: "metered",
      resume: 1,
      maxResumes: 3,
      fromLaneId: "claude-subscription",
      resumeAfter: RESUME_AFTER.toISOString(),
    });
    expect(reading.decision.offer.cost).toContain("per million tokens");
  });

  it("moves the run on a press and answers with what it did", async () => {
    const res = await POST(request(runId, "POST"), params(runId));

    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.ok).toBe(true);
    expect(result.offer.toLaneId).toBe("openrouter-glm");

    const queued = testDb
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.status, "queued"))
      .all();
    expect(queued).toHaveLength(1);
    expect(queued[0].id).toBe(result.taskId);
    expect(queued[0].runId).toBe(runId);

    const run = testDb.select().from(schema.runs).where(eq(schema.runs.id, runId)).get()!;
    expect(run.resumeCount).toBe(1);
    expect(run.status).toBe("rate_limited");
    expect(github.comments.join("\n")).toContain("Moved onto another lane by the operator");
  });

  it("refuses with 409 and the reason when the day's money is unconfirmed, writing nothing", async () => {
    confirmToday(false);

    const asked = await (await GET(request(runId), params(runId))).json();
    expect(asked.decision.ok).toBe(false);
    expect(asked.decision.refusal.reason).toBe("unconfirmed");

    const res = await POST(request(runId, "POST"), params(runId));

    expect(res.status).toBe(409);
    const result = await res.json();
    expect(result.ok).toBe(false);
    expect(result.refusal.reason).toBe("unconfirmed");
    expect(result.refusal.message).toContain("Confirm real-money spend first");
    expect(
      testDb.select().from(schema.tasks).where(eq(schema.tasks.status, "queued")).all()
    ).toEqual([]);
    expect(github.comments).toEqual([]);
  });

  it("refuses a run that is not parked", async () => {
    testDb
      .update(schema.runs)
      .set({ status: "implementing", resumeAfter: null })
      .where(eq(schema.runs.id, runId))
      .run();

    const res = await POST(request(runId, "POST"), params(runId));

    expect(res.status).toBe(409);
    expect((await res.json()).refusal.reason).toBe("not-parked");
  });

  it("answers 404 for a run that does not exist", async () => {
    const id = newId();
    expect((await GET(request(id), params(id))).status).toBe(404);
    expect((await POST(request(id, "POST"), params(id))).status).toBe(404);
  });
});
