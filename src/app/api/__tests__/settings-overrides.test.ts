import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createTestDb } from "@/test/create-test-db";
import { SETTINGS_ROW_ID, settings } from "@/db/schema";

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
import { getConfig, resetConfig, resolveAgentModelChoice } from "@/lib/config";
import { getSettingsOverrides } from "@/lib/settings";
import { getLaneCatalog, resetLaneCatalog } from "@/lib/lanes/catalog";
import { resolveLane } from "@/lib/lanes/resolve";

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
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test";
    process.env.AGENT_MODEL = "claude-opus-4-8";
    delete process.env.AGENT_MODEL_REVIEW;
    delete process.env.AGENT_MODEL_TRIAGE;
    delete process.env.AGENT_LANE;
    delete process.env.OPENROUTER_API_KEY;
    resetConfig();
    resetLaneCatalog();
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    resetConfig();
    resetLaneCatalog();
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
    ]);
    for (const field of state.fields) {
      expect(field).toMatchObject({
        source: "environment",
        override: null,
        envValue: "claude-opus-4-8",
        model: "claude-opus-4-8",
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
      tier: "light",
      model: "haiku",
      // Named, because clearing the override lands back here — and it names
      // AGENT_MODEL, the variable that would actually supply the value, since
      // AGENT_MODEL_REVIEW is unset on this install.
      envVar: "AGENT_MODEL",
      envValue: "claude-opus-4-8",
    });

    // What the orchestrator itself would read, fresh from the row. Since
    // issue #172 the resolver stops at the tier — what that tier *is* comes
    // from the lane, which the lane suite covers.
    expect(
      resolveAgentModelChoice("review", getConfig(), null, getSettingsOverrides())
    ).toEqual({ tier: "light", pinnedModel: null });
    // Untouched kinds still follow the environment, raw model id and all.
    expect(
      resolveAgentModelChoice("implement", getConfig(), null, getSettingsOverrides())
    ).toEqual({ tier: null, pinnedModel: "claude-opus-4-8" });
  });

  it("accepts a legacy vendor alias and stores the tier", async () => {
    const res = await PATCH(patch({ modelTierTriage: "haiku" }));

    const state = await res.json();
    expect(
      state.fields.find((f: { key: string }) => f.key === "modelTierTriage")
    ).toMatchObject({ override: "light", model: "haiku" });
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

/**
 * The execution-lane half of the same endpoint (issue #172). The lanes are the
 * repo's own checked-in file — read here rather than stubbed, because "the
 * screen offers the lanes the fleet would actually run" is the property under
 * test, and a fixture catalog would prove it about a file nobody ships.
 */
describe("execution lanes on /api/settings/overrides", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    testDb = createTestDb().db;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.AGENT_LANE;
    resetConfig();
    resetLaneCatalog();
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    resetConfig();
    resetLaneCatalog();
  });

  it("reports the declared lanes, which is primary, and which cannot run", async () => {
    const state = await (await GET()).json();

    expect(state.laneError).toBeNull();
    expect(state.lanes).toMatchObject({
      primaryLaneId: "claude-subscription",
      source: "preference",
      override: null,
      envVar: "AGENT_LANE",
    });
    const openrouter = state.lanes.lanes.find(
      (l: { id: string }) => l.id === "openrouter"
    );
    expect(openrouter).toMatchObject({
      available: false,
      missingEnvVars: ["OPENROUTER_API_KEY"],
    });
  });

  it("never serves a lane secret, only the names of the variables", async () => {
    // A project API route has previously leaked a stored token in cleartext.
    process.env.OPENROUTER_API_KEY = "sk-or-v1-should-never-appear";
    resetConfig();
    resetLaneCatalog();

    const body = JSON.stringify(await (await GET()).json());

    expect(body).not.toContain("sk-or-v1-should-never-appear");
    expect(body).not.toContain("sk-ant-oat01-test");
    expect(body).toContain("OPENROUTER_API_KEY");
  });

  it("stores a chosen lane, and the next pass resolves onto it", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
    resetConfig();
    resetLaneCatalog();

    const res = await PATCH(patch({ primaryLane: "openrouter" }));

    expect(res.status).toBe(200);
    const state = await res.json();
    expect(state.lanes).toMatchObject({
      primaryLaneId: "openrouter",
      source: "override",
      override: "openrouter",
    });

    // What the orchestrator itself would resolve, fresh from the row.
    const catalog = getLaneCatalog();
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;
    const resolved = resolveLane({
      catalog: catalog.catalog,
      kind: "implement",
      config: getConfig(),
      ticketModel: null,
      overrides: getSettingsOverrides(),
      env: process.env,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.lane.id).toBe("openrouter");
    expect(resolved.lane.baseUrl).toBe("https://openrouter.ai/api");
    expect(resolved.lane.auth).toEqual({ ANTHROPIC_AUTH_TOKEN: "sk-or-v1-test" });
  });

  it("names each tier's model as the primary lane resolves it", async () => {
    // The screen must not show one thing while the fleet runs another: on the
    // OpenRouter lane, `light` is an OpenRouter slug, not the CLI alias.
    process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
    delete process.env.AGENT_MODEL;
    resetConfig();
    resetLaneCatalog();

    await PATCH(patch({ modelTierReview: "light" }));
    const before = await (await GET()).json();
    expect(
      before.fields.find((f: { key: string }) => f.key === "modelTierReview")
    ).toMatchObject({ tier: "light", model: "haiku" });

    const after = await (await PATCH(patch({ primaryLane: "openrouter" }))).json();

    expect(
      after.fields.find((f: { key: string }) => f.key === "modelTierReview")
    ).toMatchObject({ tier: "light", model: "anthropic/claude-haiku-4.5" });
  });

  it("refuses a lane that is not declared, storing nothing", async () => {
    const res = await PATCH(patch({ primaryLane: "kimi" }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("claude-subscription");
    expect(getSettingsOverrides()).toEqual({});
  });

  it("clears the choice back to the file's preference order", async () => {
    await PATCH(patch({ primaryLane: "anthropic-api" }));

    const state = await (await PATCH(patch({ primaryLane: null }))).json();

    expect(state.lanes).toMatchObject({
      source: "preference",
      override: null,
      primaryLaneId: "claude-subscription",
    });
    expect(getSettingsOverrides()).toEqual({});
  });

  it("reports a stored lane a deploy has since removed, rather than erasing it", async () => {
    // The row outlives the file: a lane renamed or dropped in a deploy leaves
    // the operator's choice naming nothing. Sanitising it away on read would
    // show the screen as if the choice had never been made, and the next PATCH
    // of any other field would write that erasure back permanently — so the
    // choice is kept and *reported*, and the fleet meanwhile falls through.
    testDb
      .insert(settings)
      .values({
        id: SETTINGS_ROW_ID,
        overrides: { primaryLane: "retired-lane" },
        updatedAt: new Date(),
      })
      .run();

    const state = await (await GET()).json();
    expect(state.lanes).toMatchObject({
      unknownChoice: "retired-lane",
      primaryLaneId: "claude-subscription",
      source: "preference",
    });

    // And an unrelated write does not take the dangling choice with it.
    await PATCH(patch({ modelTierReview: "light" }));
    expect(getSettingsOverrides()).toEqual({
      primaryLane: "retired-lane",
      modelTierReview: "light",
    });
  });
});
