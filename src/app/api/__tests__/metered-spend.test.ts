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
import { recordQuotaObservation } from "@/lib/quota/quota-store";
import type { QuotaObservation } from "@/lib/quota/rate-limit-event";
import { recordMeteredSpend } from "@/lib/orchestrator/spend";
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
    delete process.env.ANTHROPIC_API_KEY;
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

/**
 * The crossing the same endpoint answers (issue #173): what would happen to an
 * attended session right now. The task screen asks it so the confirmation can
 * be offered where the human already is, and it is the *same* pure decision
 * the turn manager routes a pass with — so these cases are also the contract
 * between the two.
 */
describe("the crossing an attended session would make", () => {
  beforeEach(() => {
    testDb = createTestDb().db;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test";
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    delete process.env.ANTHROPIC_API_KEY;
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

  /** An observation on the subscription lane — the one the crossing reads,
   * since a quota row belongs to a lane (issue #175) and a metered lane never
   * reports one at all. */
  function observe(fields: Partial<QuotaObservation>): void {
    recordQuotaObservation("claude-subscription", {
      status: "allowed",
      rateLimitType: "five_hour",
      utilization: 20,
      resetsAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
      overageStatus: null,
      overageResetsAt: null,
      isUsingOverage: false,
      overageInUse: null,
      observedAt: new Date(),
      ...fields,
    });
  }

  async function crossing() {
    return (await (await GET()).json()).crossing;
  }

  it("is nothing at all on a healthy subscription day", async () => {
    observe({});

    const state = await crossing();

    expect(state.laneId).toBe("claude-subscription");
    expect(state.billing).toBe("subscription");
    expect(state.walled).toBe(false);
    expect(state.refusal).toBeNull();
    expect(state.notice).toBeNull();
  });

  it("overflows a walled window onto the cheapest paid lane, once confirmed", async () => {
    observe({ status: "rejected", utilization: null });

    const held = await crossing();
    expect(held.walled).toBe(true);
    // The *cheapest* available paid lane, not the file's first preference:
    // cost routing (issue #176) picks the target now, and the shipped file's
    // open-weights lane is roughly two orders of magnitude under the rest.
    expect(held.laneId).toBe("openrouter-glm");
    expect(held.overflowedFrom).toBe("claude-subscription");
    expect(held.refusal.reason).toBe("unconfirmed");

    const state = (await (await PATCH(patch({ confirmed: true }))).json()).crossing;

    expect(state.refusal).toBeNull();
    expect(state.laneId).toBe("openrouter-glm");
    expect(state.notice).toContain("OpenRouter");
  });

  it("reports the cap rather than an overflow once the day's cash is spent", async () => {
    observe({ status: "rejected", utilization: null });
    await PATCH(patch({ confirmed: true }));
    await PATCH(patch({ capUsd: "5" }));
    recordMeteredSpend(0, 5);

    const state = await crossing();

    expect(state.refusal.reason).toBe("cap-reached");
    expect(state.refusal.message).toContain("$5.00");
  });

  it("classifies an active overage as a paid lane, and guards the whole fleet with it", async () => {
    // The wall is up and the overage window is still serving — the request
    // succeeds and the card pays for it.
    observe({
      status: "rejected",
      utilization: null,
      overageStatus: "allowed",
      overageInUse: true,
    });

    const state = await (await GET()).json();

    // Overage spend is cash at a rate nothing writes down, so cost routing
    // (issue #176) prefers a lane whose price *is* declared and capped — but
    // the news the human is given is still the cause they are looking at,
    // which is that the plan's quota is gone and the card is being charged.
    expect(state.crossing.laneId).toBe("openrouter-glm");
    expect(state.crossing.overage).toBe(true);
    expect(state.crossing.refusal.reason).toBe("unconfirmed");
    expect(state.crossing.refusal.message).toContain("overage is covering it");
    // The same reclassification the sweep and the dashboard see: an account
    // with overage billing enabled would otherwise never show a `rejected`,
    // and the wall would silently become a bill.
    expect(state.billing).toBe("metered");
    expect(state.overage).toBe(true);
    expect(state.hold).toBe("unconfirmed");
    // ...while the lane itself still declares what it is.
    expect(state.lane.billing).toBe("subscription");
  });

  it("leaves overage merely being available alone", async () => {
    // The real captured event from a healthy account: billing configured,
    // nothing drawing on it.
    observe({ overageStatus: "allowed", overageInUse: true, isUsingOverage: false });

    const state = await (await GET()).json();

    expect(state.overage).toBe(false);
    expect(state.billing).toBe("subscription");
    expect(state.crossing.refusal).toBeNull();
  });

  it("refuses with the variables that would fix it when nothing can be paid", async () => {
    delete process.env.OPENROUTER_API_KEY;
    resetConfig();
    observe({ status: "rejected", utilization: null });

    const state = await crossing();

    expect(state.refusal.reason).toBe("no-metered-lane");
    expect(state.refusal.message).toContain("ANTHROPIC_API_KEY");
  });

  it("stops crossing once the observation's own window has reset", async () => {
    // Only a pass making an API call produces a fresh observation, so a
    // crossing held by a spent one would outlive the wall it describes.
    observe({
      status: "rejected",
      utilization: null,
      resetsAt: new Date(Date.now() - 1000),
    });

    const state = await crossing();

    expect(state.walled).toBe(false);
    expect(state.laneId).toBe("claude-subscription");
    expect(state.refusal).toBeNull();
  });
});
