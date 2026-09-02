import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LaneSettingsView, LaneView } from "@/lib/lanes/resolve";
import { ExecutionLanePanel } from "../execution-lane-settings";

/**
 * The execution-lane panel (issue #172). Its single control is which lane is
 * primary; everything else on it is *reporting*, and the reporting is what an
 * operator acts on — whether a lane can run at all, what it is missing, and
 * whether it spends real money. That reading is the contract, so it is
 * asserted rather than left to a class-string edit to quietly drop.
 *
 * The strongest assertion here is the negative one: no credential may reach
 * the markup, because a project API route has previously leaked a stored token
 * in cleartext.
 *
 * Presentational, so the view model is handed in directly.
 */

function lane(over: Partial<LaneView> = {}): LaneView {
  return {
    id: "claude-subscription",
    label: "Claude subscription",
    adapter: "claude-code",
    billing: "subscription",
    baseUrl: null,
    models: { heavy: "opus", standard: "sonnet", light: "haiku" },
    caps: { dailyBudgetUsd: null },
    authEnvVars: ["CLAUDE_CODE_OAUTH_TOKEN"],
    missingEnvVars: [],
    available: true,
    primary: true,
    ...over,
  };
}

const OPENROUTER = lane({
  id: "openrouter",
  label: "OpenRouter",
  billing: "metered",
  baseUrl: "https://openrouter.ai/api",
  models: {
    heavy: "anthropic/claude-opus-4.1",
    standard: "anthropic/claude-sonnet-4.5",
    light: "anthropic/claude-haiku-4.5",
  },
  caps: { dailyBudgetUsd: 20 },
  authEnvVars: ["OPENROUTER_API_KEY"],
  missingEnvVars: ["OPENROUTER_API_KEY"],
  available: false,
  primary: false,
});

function render(over: Partial<LaneSettingsView> = {}): string {
  return renderToStaticMarkup(
    <ExecutionLanePanel
      lanes={{
        lanes: [lane(), OPENROUTER],
        primaryLaneId: "claude-subscription",
        source: "preference",
        override: null,
        envVar: "AGENT_LANE",
        envValue: null,
        unknownChoice: null,
        ...over,
      }}
      laneError={null}
      busy={false}
      disabled={false}
      saveError={null}
      onChoose={() => {}}
    />
  );
}

describe("the execution-lane settings panel", () => {
  it("offers every declared lane plus the way back to the environment", () => {
    const html = render();

    for (const option of ["claude-subscription", "openrouter", "environment"]) {
      expect(html).toContain(`>${option}</label>`);
    }
  });

  it("checks the lane in force, so the control shows the state", () => {
    const html = render({ source: "override", override: "openrouter" });
    const input = (value: string) =>
      html.match(new RegExp(`<input[^>]*value="${value}"[^>]*>`))![0];

    expect(input("openrouter")).toContain("checked");
    expect(input("environment")).not.toContain("checked");
  });

  it("checks the environment option when the choice falls through", () => {
    const html = render();
    const input = (value: string) =>
      html.match(new RegExp(`<input[^>]*value="${value}"[^>]*>`))![0];

    expect(input("environment")).toContain("checked");
    expect(html).toContain("default order");
    expect(html).toContain("runs on claude-subscription");
  });

  it("says a lane cannot run, and names what it is missing", () => {
    // The failure this replaces was a live agent dying inside the harness with
    // "Not logged in"; the fix is only useful if the screen says which
    // variable to set.
    const html = render();

    expect(html).toContain("unavailable");
    expect(html).toContain("needs OPENROUTER_API_KEY");
  });

  it("says who pays, and what each tier means on the lane", () => {
    const html = render();

    expect(html).toContain("metered");
    expect(html).toContain("subscription");
    expect(html).toContain("https://openrouter.ai/api");
    expect(html).toContain("heavy=anthropic/claude-opus-4.1");
    expect(html).toContain("cap $20/day");
  });

  it("flags a stored choice that names no declared lane", () => {
    const html = render({ unknownChoice: "kimi" });

    expect(html).toContain("kimi");
    expect(html).toContain("names no declared lane");
  });

  it("says plainly when the lane file itself is unusable", () => {
    const html = renderToStaticMarkup(
      <ExecutionLanePanel
        lanes={null}
        laneError={'duplicate lane id "openrouter"'}
        busy={false}
        disabled={false}
        saveError={null}
        onChoose={() => {}}
      />
    );

    expect(html).toContain("No usable execution lanes");
    expect(html).toContain("duplicate lane id");
    expect(html).toContain("No pass can start");
  });

  it("shows variable names, never a value", () => {
    const html = render();

    expect(html).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(html).not.toContain("sk-");
  });
});
