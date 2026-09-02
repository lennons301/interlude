import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../config";
import type { SettingsOverrides } from "../../settings-resolver";
import { parseLaneConfig, type LaneCatalog } from "../lane-config";
import {
  choosePrimaryLane,
  describeLanes,
  laneIsAvailable,
  laneMissingEnv,
  resolveLane,
  type LaneEnv,
} from "../resolve";

/**
 * Lane resolution (issue #172) — a pure function of `(lane config, pass kind,
 * resolved settings)`, so every rule below is exercised with no provider, no
 * filesystem and no credential beyond the fake ones handed in as `env`.
 */

const CONFIG = `
primary:
  - subscription
  - direct-api
lanes:
  - id: subscription
    label: Subscription
    adapter: claude-code
    billing: subscription
    auth:
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_CODE_OAUTH_TOKEN
    models:
      heavy: opus
      standard: sonnet
      light: haiku
  - id: direct-api
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
  - id: openrouter
    adapter: claude-code
    billing: metered
    auth:
      ANTHROPIC_AUTH_TOKEN: OPENROUTER_API_KEY
    base_url: https://openrouter.ai/api
    models:
      heavy: anthropic/claude-opus-4.1
      standard: anthropic/claude-sonnet-4.5
      light: anthropic/claude-haiku-4.5
`;

const catalog: LaneCatalog = (() => {
  const parsed = parseLaneConfig(CONFIG);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.catalog;
})();

const SUBSCRIBED: LaneEnv = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" };
const EVERYTHING: LaneEnv = {
  ...SUBSCRIBED,
  ANTHROPIC_API_KEY: "sk-ant-api-test",
  OPENROUTER_API_KEY: "sk-or-v1-test",
};

function cfg(over: Partial<AppConfig> = {}): AppConfig {
  return {
    agentModel: null,
    agentModelReview: null,
    agentModelTriage: null,
    agentLane: null,
    ...over,
  } as AppConfig;
}

function resolve(
  over: {
    env?: LaneEnv;
    config?: AppConfig;
    overrides?: SettingsOverrides;
    kind?: Parameters<typeof resolveLane>[0]["kind"];
    ticketModel?: string | null;
  } = {}
) {
  return resolveLane({
    catalog,
    kind: over.kind ?? "implement",
    config: over.config ?? cfg(),
    ticketModel: over.ticketModel ?? null,
    overrides: over.overrides ?? {},
    env: over.env ?? EVERYTHING,
  });
}

describe("availability — a lane reports, rather than failing at exec", () => {
  it("names every variable a lane needs but the environment lacks", () => {
    const openrouter = catalog.lanes.find((l) => l.id === "openrouter")!;
    expect(laneMissingEnv(openrouter, SUBSCRIBED)).toEqual(["OPENROUTER_API_KEY"]);
    expect(laneIsAvailable(openrouter, SUBSCRIBED)).toBe(false);
    expect(laneIsAvailable(openrouter, EVERYTHING)).toBe(true);
  });

  it("treats an empty variable as absent", () => {
    // Doppler hands back "" for a secret that exists but was never filled in;
    // that must not read as "authenticated".
    const subscription = catalog.lanes.find((l) => l.id === "subscription")!;
    expect(laneMissingEnv(subscription, { CLAUDE_CODE_OAUTH_TOKEN: "" })).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
  });

  it("refuses to resolve an unavailable lane, naming what is missing", () => {
    const result = resolve({
      overrides: { primaryLane: "openrouter" },
      env: SUBSCRIBED,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("openrouter");
    expect(result.reason).toContain("OPENROUTER_API_KEY");
    // Still reports which lane was chosen — the operator needs to know they
    // are looking at their own choice, not a fallback.
    expect(result.choice).toMatchObject({ laneId: "openrouter", source: "override" });
  });
});

describe("which lane is primary", () => {
  it("takes the file's first available lane when nothing is set", () => {
    expect(choosePrimaryLane({ catalog, override: null, envLane: null, env: EVERYTHING }))
      .toEqual({ laneId: "subscription", source: "preference", unknownChoice: null });
  });

  it("walks past an unavailable preference — the pre-lane behaviour", () => {
    // Before lanes existed, an install with only ANTHROPIC_API_KEY simply
    // worked. The preference list is where that fallback now lives, in a file
    // a human can read.
    expect(
      choosePrimaryLane({
        catalog,
        override: null,
        envLane: null,
        env: { ANTHROPIC_API_KEY: "sk-ant-api-test" },
      }).laneId
    ).toBe("direct-api");
  });

  it("names the first preference even when none is available", () => {
    // Something has to be reported as the lane that would run: "unavailable,
    // set X" beats "no lane".
    expect(
      choosePrimaryLane({ catalog, override: null, envLane: null, env: {} })
    ).toMatchObject({ laneId: "subscription", source: "preference" });
  });

  it("lets the environment pin a lane, over the preference order", () => {
    expect(
      choosePrimaryLane({
        catalog,
        override: null,
        envLane: "openrouter",
        env: EVERYTHING,
      })
    ).toMatchObject({ laneId: "openrouter", source: "environment" });
  });

  it("lets a UI override outrank the environment", () => {
    expect(
      choosePrimaryLane({
        catalog,
        override: "direct-api",
        envLane: "openrouter",
        env: EVERYTHING,
      })
    ).toMatchObject({ laneId: "direct-api", source: "override" });
  });

  it("honours an explicit choice even when that lane cannot run", () => {
    // Never silently swap an operator's lane for a working one: routing around
    // the choice is how a fleet spends money nobody authorised.
    expect(
      choosePrimaryLane({
        catalog,
        override: "openrouter",
        envLane: null,
        env: SUBSCRIBED,
      })
    ).toMatchObject({ laneId: "openrouter", source: "override" });
  });

  it("still reports a dangling override when the environment resolves", () => {
    // The case the screen most needs: the fleet is running, but not on the
    // lane the operator picked.
    expect(
      choosePrimaryLane({
        catalog,
        override: "retired-lane",
        envLane: "openrouter",
        env: EVERYTHING,
      })
    ).toEqual({
      laneId: "openrouter",
      source: "environment",
      unknownChoice: "retired-lane",
    });
  });

  it("reports a stored choice that names no declared lane, and carries on", () => {
    const choice = choosePrimaryLane({
      catalog,
      override: "retired-lane",
      envLane: null,
      env: EVERYTHING,
    });
    expect(choice).toEqual({
      laneId: "subscription",
      source: "preference",
      unknownChoice: "retired-lane",
    });
  });
});

describe("what a resolved lane carries", () => {
  it("reads the named variables into concrete auth values", () => {
    const result = resolve({ overrides: { primaryLane: "openrouter" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lane).toMatchObject({
      id: "openrouter",
      adapter: "claude-code",
      billing: "metered",
      baseUrl: "https://openrouter.ai/api",
      auth: { ANTHROPIC_AUTH_TOKEN: "sk-or-v1-test" },
      caps: { dailyBudgetUsd: null },
    });
    // Only the lane's own variables — no other credential rides along.
    expect(Object.keys(result.lane.auth)).toEqual(["ANTHROPIC_AUTH_TOKEN"]);
  });

  it("carries the lane's caps through for the guardrails that enforce them", () => {
    const result = resolve({ overrides: { primaryLane: "direct-api" } });
    expect(result.ok && result.lane.caps).toEqual({ dailyBudgetUsd: 20 });
  });

  it("resolves the tier to the lane's own model identifier", () => {
    const heavy = resolve({
      overrides: { primaryLane: "openrouter", modelTierImplement: "heavy" },
    });
    expect(heavy.ok && heavy.lane.model).toBe("anthropic/claude-opus-4.1");

    const light = resolve({
      overrides: { primaryLane: "openrouter", modelTierImplement: "light" },
    });
    expect(light.ok && light.lane.model).toBe("anthropic/claude-haiku-4.5");
  });

  it("gives each pass kind the tier its own setting names", () => {
    const overrides: SettingsOverrides = {
      primaryLane: "openrouter",
      modelTierImplement: "heavy",
      modelTierReview: "light",
      modelTierTriage: "light",
      modelTierInteractive: "standard",
    };
    const modelFor = (kind: Parameters<typeof resolveLane>[0]["kind"]) => {
      const r = resolve({ kind, overrides });
      return r.ok ? r.lane.model : null;
    };
    expect(modelFor("implement")).toBe("anthropic/claude-opus-4.1");
    // Repair is implement-shaped — the same attempt continuing.
    expect(modelFor("repair")).toBe("anthropic/claude-opus-4.1");
    expect(modelFor("review")).toBe("anthropic/claude-haiku-4.5");
    expect(modelFor("triage")).toBe("anthropic/claude-haiku-4.5");
    expect(modelFor("interactive")).toBe("anthropic/claude-sonnet-4.5");
  });

  it("lets a ticket's model directive choose the tier, on its own work only", () => {
    const overrides: SettingsOverrides = {
      primaryLane: "openrouter",
      modelTierReview: "light",
    };
    // The ticket chooses the model its *work* runs on...
    const implement = resolve({ kind: "implement", ticketModel: "heavy", overrides });
    expect(implement.ok && implement.lane.model).toBe("anthropic/claude-opus-4.1");
    // ...never the reviewer's.
    const review = resolve({ kind: "review", ticketModel: "heavy", overrides });
    expect(review.ok && review.lane.model).toBe("anthropic/claude-haiku-4.5");
  });

  it("round-trips the tier the run ledger records, on any lane", () => {
    // The ledger stores the *tier* (issue #172), and every later pass of the
    // attempt reads it back as the run's `model:` directive. Storing the
    // resolved identifier instead would drop the directive the moment the
    // fleet left a lane whose ids happen to be tier aliases.
    const first = resolve({
      kind: "implement",
      ticketModel: "heavy",
      overrides: { primaryLane: "openrouter" },
    });
    expect(first.ok && first.lane.tier).toBe("heavy");

    const recorded = first.ok ? first.lane.tier : null;
    const later = resolve({
      kind: "repair",
      ticketModel: recorded,
      overrides: { primaryLane: "openrouter" },
    });
    expect(later.ok && later.lane.model).toBe("anthropic/claude-opus-4.1");
  });

  it("accepts a legacy vendor alias as a tier", () => {
    const result = resolve({
      kind: "implement",
      ticketModel: "sonnet",
      overrides: { primaryLane: "openrouter" },
    });
    expect(result.ok && result.lane.tier).toBe("standard");
    expect(result.ok && result.lane.model).toBe("anthropic/claude-sonnet-4.5");
  });

  it("passes an environment-pinned raw model id through verbatim", () => {
    // A deployment pinning `AGENT_MODEL=claude-opus-4-8` names an identifier it
    // knows its endpoint accepts; there is no tier to translate, so translating
    // would be a guess.
    const result = resolve({
      config: cfg({ agentModel: "claude-opus-4-8" }),
      overrides: { primaryLane: "openrouter" },
    });
    expect(result.ok && result.lane.tier).toBeNull();
    expect(result.ok && result.lane.model).toBe("claude-opus-4-8");
  });

  it("passes no model at all when nothing names one", () => {
    // The pre-#74 behaviour: no `--model`, the harness resolves its own
    // default. An install that has configured nothing must keep working.
    const result = resolve();
    expect(result.ok && result.lane.model).toBeNull();
    expect(result.ok && result.lane.id).toBe("subscription");
  });

  it("keeps the subscription lane's mapping identical to the pre-lane one", () => {
    const result = resolve({ overrides: { modelTierImplement: "standard" } });
    expect(result.ok && result.lane.model).toBe("sonnet");
  });
});

describe("describeLanes — what the settings screen is handed", () => {
  const view = describeLanes({
    catalog,
    config: cfg({ agentLane: "direct-api" }),
    overrides: {},
    env: SUBSCRIBED,
  });

  it("reports the lane in force and where the choice came from", () => {
    expect(view).toMatchObject({
      primaryLaneId: "direct-api",
      source: "environment",
      override: null,
      envVar: "AGENT_LANE",
      envValue: "direct-api",
      unknownChoice: null,
    });
  });

  it("reports each lane's availability with the variables it is missing", () => {
    const openrouter = view.lanes.find((l) => l.id === "openrouter")!;
    expect(openrouter).toMatchObject({
      available: false,
      missingEnvVars: ["OPENROUTER_API_KEY"],
      authEnvVars: ["OPENROUTER_API_KEY"],
      billing: "metered",
      primary: false,
    });
    expect(view.lanes.find((l) => l.id === "subscription")!.available).toBe(true);
  });

  it("carries variable names only — never a value", () => {
    // A project API route has previously leaked a stored token in cleartext;
    // nothing on this path may serve a credential.
    const serialised = JSON.stringify(view);
    for (const secret of Object.values(EVERYTHING)) {
      expect(serialised).not.toContain(secret);
    }
    expect(serialised).not.toContain("sk-");
  });
});
