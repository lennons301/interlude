import { describe, expect, it } from "vitest";
import { parseLaneConfig, type LaneCatalog } from "../lane-config";
import { describeLaneAvailability, unavailableLanes } from "../availability";
import { resolveLane, type LaneEnv } from "../resolve";
import type { AppConfig } from "../../config";

/**
 * The boot-time lane-availability report (issue #226): read off the catalog,
 * one line per unavailable lane naming the variables it lacks, and silent when
 * every lane is available. It replaced a warning that named one vendor's two
 * credential variables and could say nothing about any other lane.
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
      HARNESS_TOKEN: PLAN_TOKEN
    models:
      heavy: a
      standard: b
      light: c
  - id: direct-api
    adapter: claude-code
    billing: metered
    auth:
      HARNESS_KEY: DIRECT_API_KEY
    models:
      heavy: a
      standard: b
      light: c
  - id: two-keys
    adapter: claude-code
    billing: metered
    auth:
      HARNESS_TOKEN: THIRD_PARTY_KEY
      HARNESS_ORG: THIRD_PARTY_ORG
    base_url: https://example.test/api
    models:
      heavy: a
      standard: b
      light: c
    prices:
      heavy: { input: 1, output: 1 }
      standard: { input: 1, output: 1 }
      light: { input: 1, output: 1 }
`;

const catalog: LaneCatalog = (() => {
  const parsed = parseLaneConfig(CONFIG);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.catalog;
})();

const EVERYTHING: LaneEnv = {
  PLAN_TOKEN: "t",
  DIRECT_API_KEY: "k",
  THIRD_PARTY_KEY: "tp",
  THIRD_PARTY_ORG: "org",
};

describe("unavailableLanes", () => {
  it("is empty when every lane's variables are present", () => {
    expect(unavailableLanes(catalog, EVERYTHING)).toEqual([]);
  });

  it("lists each unavailable lane with the variables it lacks, in declaration order", () => {
    expect(unavailableLanes(catalog, { PLAN_TOKEN: "t" })).toEqual([
      { id: "direct-api", missingEnvVars: ["DIRECT_API_KEY"] },
      { id: "two-keys", missingEnvVars: ["THIRD_PARTY_KEY", "THIRD_PARTY_ORG"] },
    ]);
  });

  it("names only the variables actually missing when a lane lacks some of several", () => {
    expect(
      unavailableLanes(catalog, { ...EVERYTHING, THIRD_PARTY_ORG: undefined })
    ).toEqual([{ id: "two-keys", missingEnvVars: ["THIRD_PARTY_ORG"] }]);
  });

  it("reads a blank variable as missing, as the resolver does", () => {
    expect(unavailableLanes(catalog, { ...EVERYTHING, PLAN_TOKEN: "" })).toEqual([
      { id: "subscription", missingEnvVars: ["PLAN_TOKEN"] },
    ]);
  });

  it("reports every lane when the environment holds nothing — the fresh-deployment case", () => {
    expect(unavailableLanes(catalog, {}).map((lane) => lane.id)).toEqual([
      "subscription",
      "direct-api",
      "two-keys",
    ]);
  });
});

describe("describeLaneAvailability", () => {
  it("says nothing when every lane is available", () => {
    expect(describeLaneAvailability(catalog, EVERYTHING)).toEqual([]);
  });

  it("names the lane and its variables, one line per unavailable lane", () => {
    const lines = describeLaneAvailability(catalog, { PLAN_TOKEN: "t" });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"direct-api"');
    expect(lines[0]).toContain("DIRECT_API_KEY is not set");
    expect(lines[1]).toContain('"two-keys"');
    expect(lines[1]).toContain("THIRD_PARTY_KEY, THIRD_PARTY_ORG are not set");
  });

  it("uses the resolver's own wording, so the boot line is the line a pass would fail with", () => {
    const [line] = describeLaneAvailability(catalog, { PLAN_TOKEN: "t", THIRD_PARTY_KEY: "tp", THIRD_PARTY_ORG: "org" });
    const refused = resolveLane({
      catalog,
      kind: "implement",
      config: { agentLane: "direct-api" } as AppConfig,
      ticketModel: null,
      overrides: {},
      env: { PLAN_TOKEN: "t" },
    });
    expect(refused.ok).toBe(false);
    expect(line).toBe(refused.ok ? "" : refused.reason);
  });

  it("names no vendor: the report is the catalog's, in the lane file's own words", () => {
    for (const line of describeLaneAvailability(catalog, {})) {
      expect(line).not.toMatch(/claude|anthropic/i);
    }
  });
});
