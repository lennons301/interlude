import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createTestDb } from "@/test/create-test-db";

// The money guards' endpoint (issue #174) against a from-migrations DB: what
// the settings screen calls, and what the autonomy sweep then reads. The route
// is thin on purpose — the policy lives in the pure guards — so what is checked
// here is that it reports the state the reducer would decide on, refuses a bad
// cap without storing it, and that a confirmation is visible to the
// orchestrator's own read.
let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

import { GET, PATCH } from "@/app/api/settings/metered-spend/route";
import { resetConfig } from "@/lib/config";
import { getFleetSettings } from "@/lib/settings";
import { resetLaneCatalog } from "@/lib/lanes/catalog";
import { MAX_METERED_DAILY_CAP_USD } from "@/lib/orchestrator/autonomy/budgets";

function patch(body: unknown, raw?: string): Request {
  return new Request("http://test/api/settings/metered-spend", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
}

const savedEnv = { ...process.env };

describe("GET/PATCH /api/settings/metered-spend", () => {
  beforeEach(() => {
    testDb = createTestDb().db;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test";
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    delete process.env.AGENT_LANE;
    delete process.env.METERED_DAILY_CAP_USD;
    resetConfig();
    resetLaneCatalog();
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    resetConfig();
    resetLaneCatalog();
  });

  it("reports a subscription fleet as costing no cash and holding nothing", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    const state = await res.json();
    expect(state.lane.billing).toBe("subscription");
    expect(state.metered).toBe(false);
    expect(state.hold).toBeNull();
    expect(state.spentTodayUsd).toBe(0);
    // The env default, since nothing has been overridden on this install.
    expect(state.cap.capUsd).toBe(20);
    expect(state.cap.source).toBe("environment");
  });

  it("holds an unconfirmed metered lane, and clears on one confirmation", async () => {
    process.env.AGENT_LANE = "openrouter";
    resetConfig();

    const held = await (await GET()).json();
    expect(held.lane.id).toBe("openrouter");
    expect(held.hold).toBe("unconfirmed");

    const res = await PATCH(patch({ confirmed: true }));

    expect(res.status).toBe(200);
    const state = await res.json();
    expect(state.confirmedToday).toBe(true);
    expect(state.hold).toBeNull();
    // The orchestrator's own read of the row agrees — it is the same fact.
    expect(getFleetSettings().meteredSpendConfirmedAt).not.toBeNull();
  });

  it("withdraws a confirmation", async () => {
    process.env.AGENT_LANE = "openrouter";
    resetConfig();
    await PATCH(patch({ confirmed: true }));

    const state = await (await PATCH(patch({ confirmed: false }))).json();

    expect(state.confirmedToday).toBe(false);
    expect(state.hold).toBe("unconfirmed");
    expect(getFleetSettings().meteredSpendConfirmedAt).toBeNull();
  });

  it("rejects a non-boolean confirmation without touching the row", async () => {
    const res = await PATCH(patch({ confirmed: "yes" }));

    expect(res.status).toBe(400);
    expect(getFleetSettings().meteredSpendConfirmedAt).toBeNull();
  });

  it("stores a cap and reports where it came from", async () => {
    const state = await (await PATCH(patch({ capUsd: "12.5" }))).json();

    expect(state.cap.capUsd).toBe(12.5);
    expect(state.cap.source).toBe("override");
    expect(getFleetSettings().overrides.meteredDailyCapUsd).toBe("12.5");
  });

  it("refuses a cap past the code ceiling, with the reason, storing nothing", async () => {
    const res = await PATCH(
      patch({ capUsd: String(MAX_METERED_DAILY_CAP_USD + 1) })
    );

    expect(res.status).toBe(400);
    // Refused with what would have been accepted, never clamped to the ceiling.
    expect((await res.json()).error).toContain(`$${MAX_METERED_DAILY_CAP_USD}`);
    expect(getFleetSettings().overrides.meteredDailyCapUsd).toBeUndefined();
  });

  it("lets the chosen lane's own declared cap bind a higher dial down", async () => {
    // openrouter declares caps.daily_budget_usd: 20 in lanes.yaml.
    process.env.AGENT_LANE = "openrouter";
    resetConfig();

    const state = await (await PATCH(patch({ capUsd: "80" }))).json();

    expect(state.cap.settingUsd).toBe(80);
    expect(state.cap.capUsd).toBe(20);
    expect(state.cap.boundBy).toBe("lane");
  });

  it("clears the cap back to the environment default", async () => {
    await PATCH(patch({ capUsd: "12.5" }));

    const state = await (await PATCH(patch({ capUsd: null }))).json();

    expect(state.cap.capUsd).toBe(20);
    expect(state.cap.source).toBe("environment");
  });

  it("refuses a request that asks for nothing", async () => {
    expect((await PATCH(patch({}))).status).toBe(400);
    expect((await PATCH(patch(null, "not json"))).status).toBe(400);
  });

  it("serves no credential — variable values never cross this route", async () => {
    process.env.AGENT_LANE = "openrouter";
    resetConfig();

    const body = JSON.stringify(await (await GET()).json());

    expect(body).not.toContain("sk-or-test");
    expect(body).not.toContain("sk-ant-oat01-test");
  });
});
