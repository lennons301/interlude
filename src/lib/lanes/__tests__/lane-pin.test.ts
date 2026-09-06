import { describe, expect, it } from "vitest";
import type { FleetSettings } from "../../settings";
import { HARNESS_ADAPTER_DESCRIPTORS } from "../../harness/descriptors";
import { parseLaneConfig, type LaneCatalog } from "../lane-config";
import { checkLanePin, overridesPinnedTo, settingsPinnedTo } from "../lane-pin";

/**
 * The pure half of a lane pin (issue #241): a pin is the operator's explicit
 * lane choice scoped to one pass, so it is expressed as that same choice —
 * settings whose `primaryLane` is the pin — and nothing else. These tests pin
 * that identity, and that a requested pin is judged the way the resolver
 * judges the fleet's own primary.
 */

const LANES = `
primary:
  - claude-subscription
lanes:
  - id: claude-subscription
    label: Claude subscription
    adapter: claude-code
    billing: subscription
    auth:
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_CODE_OAUTH_TOKEN
    models:
      heavy: opus
      standard: sonnet
      light: haiku
  - id: anthropic-api
    label: Anthropic API
    adapter: claude-code
    billing: metered
    auth:
      ANTHROPIC_API_KEY: ANTHROPIC_API_KEY
    models:
      heavy: opus
      standard: sonnet
      light: haiku
    caps:
      daily_budget_usd: 20
`;

function catalog(): LaneCatalog {
  const parsed = parseLaneConfig(LANES, HARNESS_ADAPTER_DESCRIPTORS);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.catalog;
}

const settings: FleetSettings = {
  globalAutonomyPaused: false,
  meteredSpendConfirmedAt: null,
  overrides: { primaryLane: "claude-subscription", modelTierReview: "standard" },
  updatedAt: null,
};

describe("overridesPinnedTo / settingsPinnedTo", () => {
  it("returns the fleet's own settings, by identity, when there is no pin", () => {
    expect(overridesPinnedTo(settings.overrides, null)).toBe(settings.overrides);
    expect(overridesPinnedTo(settings.overrides, undefined)).toBe(settings.overrides);
    expect(settingsPinnedTo(settings, null)).toBe(settings);
  });

  it("stands the pin in as the operator's explicit lane and leaves every other setting alone", () => {
    const pinned = settingsPinnedTo(settings, "anthropic-api");
    expect(pinned.overrides).toEqual({ primaryLane: "anthropic-api", modelTierReview: "standard" });
    expect(pinned.meteredSpendConfirmedAt).toBe(settings.meteredSpendConfirmedAt);
    expect(pinned.globalAutonomyPaused).toBe(settings.globalAutonomyPaused);
  });

  it("never mutates the fleet's settings — a pin is scoped to the pass it was read for", () => {
    settingsPinnedTo(settings, "anthropic-api");
    expect(settings.overrides.primaryLane).toBe("claude-subscription");
  });
});

describe("checkLanePin", () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: "oauth" };

  it("accepts a declared, available lane", () => {
    expect(checkLanePin("claude-subscription", catalog(), env)).toEqual({
      ok: true,
      laneId: "claude-subscription",
    });
  });

  it("refuses a value that is not a lane id at all as an input error", () => {
    for (const bad of [42, "", "Not A Lane", null, undefined]) {
      const check = checkLanePin(bad, catalog(), env);
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.status).toBe(400);
    }
  });

  it("refuses a lane nobody declared, naming the ones that are", () => {
    const check = checkLanePin("openrouter", catalog(), env);
    expect(check).toEqual({
      ok: false,
      status: 400,
      error: 'lane "openrouter" is not declared in lanes.yaml — declared lanes: claude-subscription, anthropic-api',
    });
  });

  it("refuses a declared lane the environment cannot run, in the resolver's own words", () => {
    const check = checkLanePin("anthropic-api", catalog(), env);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.status).toBe(409);
      expect(check.error).toContain('execution lane "anthropic-api" is unavailable');
      expect(check.error).toContain("ANTHROPIC_API_KEY");
    }
  });

  it("refuses every pin when the lane file itself could not be read", () => {
    const check = checkLanePin("claude-subscription", null, env);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.status).toBe(409);
  });
});
