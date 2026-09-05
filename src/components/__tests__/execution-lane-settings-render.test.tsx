import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HarnessImageState } from "@/lib/harness/image-state";
import type { LaneSettingsView, LaneView } from "@/lib/lanes/resolve";
import { ExecutionLanePanel } from "../execution-lane-settings";
import { errorFor } from "../settings-overrides";

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
    capabilities: {
      userInvokedSkills: true,
      quotaTelemetry: true,
      reportsCost: true,
      sessionResume: true,
    },
    billing: "subscription",
    baseUrl: null,
    models: { heavy: "opus", standard: "sonnet", light: "haiku" },
    prices: null,
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

/** The Claude Code image, built — the shipped state. */
const CLAUDE_IMAGE: HarnessImageState = {
  id: "claude-code",
  image: "interlude-agent:latest",
  built: true,
};

function render(
  over: Partial<LaneSettingsView> = {},
  harnesses: HarnessImageState[] = [CLAUDE_IMAGE]
): string {
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
      harnesses={harnesses}
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
        harnesses={[]}
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

/**
 * Per lane: the harness, whether its image is built, and whether its
 * credentials are present (issue #219) — the three facts that decide whether
 * a pass can start there, so an unavailable lane is explained before one tries.
 */
describe("harness, image and credentials per lane (issue #219)", () => {
  it("names the harness and its image, and says the image is ready", () => {
    const html = render();

    expect(html).toContain("harness claude-code");
    expect(html).toContain("interlude-agent:latest");
    expect(html).toContain("image ready");
    expect(html).not.toContain("image not built");
  });

  it("says when the harness image is not built, in amber rather than red", () => {
    // A missing image is built on demand at the first pass — a delay, where a
    // missing credential fails the pass as it starts.
    const html = render({}, [{ ...CLAUDE_IMAGE, built: false }]);

    expect(html).toContain("image not built");
    expect(html).toMatch(/fl-amber[^>]*>image not built/);
  });

  it("reads a daemon that did not answer as unknown, never as a verdict", () => {
    expect(render({}, [{ ...CLAUDE_IMAGE, built: null }])).toContain("image unknown");
    // No answer for this adapter at all reads the same way.
    expect(render({}, [])).toContain("image unknown");
  });

  it("keeps the credential report beside the harness facts", () => {
    const html = render();

    expect(html).toContain("available");
    expect(html).toContain("unavailable");
    expect(html).toContain("needs OPENROUTER_API_KEY");
  });

  it("names what a harness declares it cannot do, and nothing for one that can do it all", () => {
    // The reason a quota tile reads "cannot report", or the parser insists on
    // prices, for a lane on this harness — named where the lane is.
    const html = render({
      lanes: [
        lane(),
        lane({
          id: "codex-subscription",
          label: "Codex subscription",
          adapter: "codex",
          capabilities: {
            userInvokedSkills: true,
            quotaTelemetry: false,
            reportsCost: false,
            sessionResume: true,
          },
          primary: false,
        }),
      ],
    });

    expect(html).toContain("harness codex");
    expect(html).toContain("no quota telemetry");
    expect(html).toContain("no cost report");
    expect(html).not.toContain("no session resume");
    // The Claude Code row declares no gap, so it carries no such line.
    expect(html.split("harness limits").length - 1).toBe(1);
  });
});

describe("a save error belongs to the panel whose field failed", () => {
  // The two panels share one piece of state, because a tier's model id is
  // whatever the lane resolves it to — but not one error line: a refused lane
  // must not raise a red alert under Models, where nothing went wrong.
  const laneFailure = { key: "primaryLane", message: "That didn't stick — nope" };
  const tierFailure = { key: "modelTierReview", message: "That didn't stick — nope" };

  it("shows a refused lane only on the lane panel", () => {
    expect(errorFor(laneFailure, "lane")).toBe(laneFailure.message);
    expect(errorFor(laneFailure, "tiers")).toBeNull();
  });

  it("shows a refused tier only on the model panel", () => {
    expect(errorFor(tierFailure, "tiers")).toBe(tierFailure.message);
    expect(errorFor(tierFailure, "lane")).toBeNull();
  });

  it("shows nothing on either when the last save succeeded", () => {
    expect(errorFor(null, "lane")).toBeNull();
    expect(errorFor(null, "tiers")).toBeNull();
  });

  it("shows what a lane charges, per tier, and says when it has no prices", () => {
    // Issue #175: off an Anthropic-direct endpoint these figures are what the
    // fleet's budgets are actually measured against, so the screen has to name
    // them. A lane that declares none says so rather than showing blanks.
    const html = render({
      lanes: [
        lane(),
        lane({
          id: "openrouter-glm",
          label: "OpenRouter (GLM open weights)",
          billing: "metered",
          baseUrl: "https://openrouter.ai/api",
          models: {
            heavy: "z-ai/glm-5.3",
            standard: "z-ai/glm-5.3-flash",
            light: "z-ai/glm-4.7-flash",
          },
          prices: {
            heavy: {
              inputPerMTok: 1.4,
              outputPerMTok: 4.4,
              cacheReadPerMTok: 0.26,
              cacheWritePerMTok: null,
            },
            standard: {
              inputPerMTok: 0.075,
              outputPerMTok: 0.25,
              cacheReadPerMTok: 0.015,
              cacheWritePerMTok: null,
            },
            light: {
              inputPerMTok: 0.06,
              outputPerMTok: 0.4,
              cacheReadPerMTok: 0.01,
              cacheWritePerMTok: null,
            },
          },
          primary: false,
        }),
      ],
    });

    expect(html).toContain("standard=0.075/0.25");
    // The subscription lane declares none: the harness's own figure is charged
    // there, and inventing a table would create a second copy to rot.
    expect(html).toContain("prices from the harness&#x27;s own reported cost");
  });
});
