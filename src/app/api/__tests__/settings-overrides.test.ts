import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createTestDb } from "@/test/create-test-db";

// The UI-editable settings endpoint (issue #166) against a from-migrations DB:
// what the settings screen calls, and what the next pass then reads. The route
// is thin on purpose — the rules live in the pure resolver — so what is checked
// here is that it reports the resolved state, refuses without storing, and that
// a stored change is visible to the orchestrator's own read.
let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

import { GET, PATCH } from "@/app/api/settings/overrides/route";
import { getConfig, resetConfig, resolveAgentModel } from "@/lib/config";
import { getSettingsOverrides } from "@/lib/settings";

function patch(body: unknown, raw?: string): Request {
  return new Request("http://test/api/settings/overrides", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
}

const savedEnv = { ...process.env };

describe("GET/PATCH /api/settings/overrides", () => {
  beforeEach(() => {
    testDb = createTestDb().db;
    process.env.ANTHROPIC_API_KEY = "test-key"; // silence the no-auth warning
    process.env.AGENT_MODEL = "claude-opus-4-8";
    delete process.env.AGENT_MODEL_REVIEW;
    delete process.env.AGENT_MODEL_TRIAGE;
    resetConfig();
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    resetConfig();
  });

  it("reports every field as falling through on a fresh install", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    const state = await res.json();
    expect(state.updatedAt).toBeNull();
    expect(state.fields.map((f: { key: string }) => f.key)).toEqual([
      "modelTierImplement",
      "modelTierReview",
      "modelTierTriage",
      "modelTierInteractive",
      "quotaPickupThresholdPercent",
    ]);
    for (const field of state.fields.filter(
      (f: { detail: { kind: string } }) => f.detail.kind === "model-tier"
    )) {
      expect(field).toMatchObject({
        source: "environment",
        override: null,
        envValue: "claude-opus-4-8",
        detail: { model: "claude-opus-4-8" },
      });
    }
  });

  it("stores an override, and the next pass resolves onto it", async () => {
    const res = await PATCH(patch({ modelTierReview: "light" }));

    expect(res.status).toBe(200);
    const state = await res.json();
    expect(
      state.fields.find((f: { key: string }) => f.key === "modelTierReview")
    ).toMatchObject({
      source: "override",
      override: "light",
      detail: { kind: "model-tier", tier: "light", model: "haiku" },
      // Named, because clearing the override lands back here — and it names
      // AGENT_MODEL, the variable that would actually supply the value, since
      // AGENT_MODEL_REVIEW is unset on this install.
      envVar: "AGENT_MODEL",
      envValue: "claude-opus-4-8",
    });

    // What the orchestrator itself would read, fresh from the row.
    expect(
      resolveAgentModel("review", getConfig(), null, getSettingsOverrides())
    ).toBe("haiku");
    // Untouched kinds still follow the environment.
    expect(
      resolveAgentModel("implement", getConfig(), null, getSettingsOverrides())
    ).toBe("claude-opus-4-8");
  });

  it("accepts a legacy vendor alias and stores the tier", async () => {
    const res = await PATCH(patch({ modelTierTriage: "haiku" }));

    const state = await res.json();
    expect(
      state.fields.find((f: { key: string }) => f.key === "modelTierTriage")
    ).toMatchObject({
      override: "light",
      detail: { kind: "model-tier", model: "haiku" },
    });
  });

  it("clears an override back to the environment default", async () => {
    await PATCH(patch({ modelTierTriage: "light" }));

    const res = await PATCH(patch({ modelTierTriage: null }));

    const state = await res.json();
    expect(
      state.fields.find((f: { key: string }) => f.key === "modelTierTriage")
    ).toMatchObject({ source: "environment", override: null });
    expect(getSettingsOverrides()).toEqual({});
  });

  it("rejects a disallowed value with the reason, storing nothing", async () => {
    const res = await PATCH(patch({ modelTierReview: "turbo" }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("heavy, standard, light");
    expect(getSettingsOverrides()).toEqual({});
  });

  it("rejects a safety ceiling by name", async () => {
    const res = await PATCH(patch({ maxAttemptBudgetUsd: "500" }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("safety ceiling");
    expect(getSettingsOverrides()).toEqual({});
  });

  it("rejects an unparseable body", async () => {
    const res = await PATCH(patch(null, "not json"));

    expect(res.status).toBe(400);
    expect(getSettingsOverrides()).toEqual({});
  });
});
