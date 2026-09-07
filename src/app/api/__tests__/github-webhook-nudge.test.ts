import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb } from "@/test/create-test-db";

/**
 * The GitHub webhook route records a nudge and never sweeps (issue #163).
 *
 * The route runs on the app-router module graph. A sweep started from there
 * ran against that graph's own empty copies of the sweep's single-flight flag
 * and in-flight claims, so the interval sweep on the orchestrator graph and the
 * webhook's sweep could both claim one ticket — which they did, 250 ms apart,
 * on 2026-09-06. The whole sweep module is mocked here so that if the route
 * ever imports it again the assertion below, not production, is what notices.
 */

let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));
vi.mock("@/lib/github/client", () => ({ isGitHubConfigured: () => true }));
vi.mock("@/lib/github/webhooks", () => ({ verifyWebhookSignature: () => true }));
vi.mock("@/lib/github/issues", () => ({
  addLabelToIssue: vi.fn(async () => true),
  commentOnIssue: vi.fn(async () => true),
}));
const runAutonomySweep = vi.fn(async () => {});
vi.mock("@/lib/orchestrator/autonomy/sweep", () => ({
  runAutonomySweep,
  startAutonomySweeps: vi.fn(),
  armIssueFromDiscord: vi.fn(),
}));

import { POST } from "@/app/api/webhooks/github/route";
import { isSweepRequested, takeSweepNudge } from "@/lib/orchestrator/autonomy/sweep-nudge";
import { projects } from "@/db/schema";

function webhook(event: string, payload: unknown): Request {
  return new Request("http://test/api/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-hub-signature-256": "sha256=test",
    },
    body: JSON.stringify(payload),
  });
}

const ISSUE = {
  number: 123,
  title: "One ticket",
  body: "",
  labels: [{ name: "ready-for-agent" }],
};
const REPO = { full_name: "lennons301/moontide" };

describe("POST /api/webhooks/github (issue #163)", () => {
  beforeEach(() => {
    testDb = createTestDb().db;
    takeSweepNudge();
    runAutonomySweep.mockClear();
  });

  it("an arming label records a nudge for the orchestrator's loop and does not sweep", async () => {
    const res = await POST(
      webhook("issues", {
        action: "labeled",
        label: { name: "ready-for-agent" },
        issue: ISSUE,
        repository: REPO,
      })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, triggered: "autonomy-sweep" });
    expect(runAutonomySweep).not.toHaveBeenCalled();
    expect(isSweepRequested()).toBe(true);
    expect(takeSweepNudge()?.reasons).toEqual([
      "issues.labeled ready-for-agent lennons301/moontide#123",
    ]);
  });

  it("a new issue on a registered project is labelled needs-triage and nudges, without sweeping", async () => {
    testDb
      .insert(projects)
      .values({
        id: "01PROJECT",
        name: "moontide",
        githubRepo: REPO.full_name,
        createdAt: new Date(),
      })
      .run();

    const res = await POST(
      webhook("issues", {
        action: "opened",
        issue: { ...ISSUE, labels: [] },
        repository: REPO,
      })
    );

    expect(await res.json()).toEqual({ ok: true, triggered: "triage" });
    expect(runAutonomySweep).not.toHaveBeenCalled();
    expect(takeSweepNudge()?.reasons).toEqual(["issues.opened lennons301/moontide#123"]);
  });

  it("two arming webhooks for one ticket collapse into one pending nudge", async () => {
    const body = {
      action: "labeled",
      label: { name: "ready-for-agent" },
      issue: ISSUE,
      repository: REPO,
    };
    await POST(webhook("issues", body));
    await POST(webhook("issues", body));

    expect(runAutonomySweep).not.toHaveBeenCalled();
    expect(takeSweepNudge()?.reasons).toHaveLength(1);
    expect(isSweepRequested()).toBe(false);
  });
});
