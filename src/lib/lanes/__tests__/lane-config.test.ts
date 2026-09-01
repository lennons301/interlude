import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { parseLaneConfig, laneIds } from "../lane-config";
import { LANE_CONFIG_FILE } from "../catalog";

/**
 * The lane-file parser (issue #172). Two jobs are tested here: that a valid
 * file becomes the catalog the resolver expects, and that every way of getting
 * it wrong is refused *whole*, with a reason. The second matters more — this
 * file decides what every unattended pass on the box authenticates as, so a
 * near-miss that half-loads is worse than a hard failure.
 */

const VALID = `
primary:
  - claude-subscription
  - anthropic-api
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
    adapter: claude-code
    billing: metered
    auth:
      ANTHROPIC_API_KEY: ANTHROPIC_API_KEY
    base_url: https://api.anthropic.com/
    models:
      heavy: opus
      standard: sonnet
      light: haiku
    caps:
      daily_budget_usd: 20
`;

function parse(text: string) {
  const result = parseLaneConfig(text);
  if (!result.ok) throw new Error(`expected a valid config: ${result.reason}`);
  return result.catalog;
}

function reasonFor(text: string): string {
  const result = parseLaneConfig(text);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.reason;
}

describe("parseLaneConfig", () => {
  it("reads a lane as the whole bundle the resolver needs", () => {
    const [subscription, api] = parse(VALID).lanes;
    expect(subscription).toEqual({
      id: "claude-subscription",
      label: "Claude subscription",
      adapter: "claude-code",
      billing: "subscription",
      auth: [
        { harnessVar: "CLAUDE_CODE_OAUTH_TOKEN", fromEnv: "CLAUDE_CODE_OAUTH_TOKEN" },
      ],
      baseUrl: null,
      models: { heavy: "opus", standard: "sonnet", light: "haiku" },
      caps: { dailyBudgetUsd: null },
    });
    expect(api.billing).toBe("metered");
    expect(api.caps.dailyBudgetUsd).toBe(20);
    // A label is optional; the id stands in, because a screen with a blank row
    // is worse than one showing the slug.
    expect(api.label).toBe("anthropic-api");
  });

  it("maps a harness variable to a differently-named source variable", () => {
    // The whole reason auth is a mapping: Claude Code reads
    // ANTHROPIC_AUTH_TOKEN, while the OpenRouter key is provisioned under its
    // own name.
    const catalog = parse(`
primary: openrouter
lanes:
  - id: openrouter
    adapter: claude-code
    billing: metered
    auth:
      ANTHROPIC_AUTH_TOKEN: OPENROUTER_API_KEY
    base_url: https://openrouter.ai/api
    models: { heavy: a, standard: b, light: c }
`);
    expect(catalog.lanes[0].auth).toEqual([
      { harnessVar: "ANTHROPIC_AUTH_TOKEN", fromEnv: "OPENROUTER_API_KEY" },
    ]);
  });

  it("keeps the preference order, and accepts a single id as one", () => {
    expect(parse(VALID).preference).toEqual([
      "claude-subscription",
      "anthropic-api",
    ]);
    expect(
      parse(VALID.replace(/primary:\n.*\n.*\n/, "primary: anthropic-api\n"))
        .preference
    ).toEqual(["anthropic-api"]);
  });

  it("strips a trailing slash from a base URL", () => {
    // Left on, it doubles against the path the harness appends — a 404 the
    // operator has to debug from the provider's end.
    expect(parse(VALID).lanes[1].baseUrl).toBe("https://api.anthropic.com");
  });

  describe("refuses a document that would run the fleet somewhere unintended", () => {
    it("rejects an inlined secret where a variable name belongs", () => {
      // The load-bearing rule: a credential pasted into the file is a parse
      // error, not a secret checked into git and served from an API route.
      const reason = reasonFor(
        VALID.replace(
          "CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_CODE_OAUTH_TOKEN",
          "CLAUDE_CODE_OAUTH_TOKEN: sk-ant-oat01-hunter2"
        )
      );
      expect(reason).toContain("never the secret itself");
    });

    it("rejects an unknown harness adapter", () => {
      expect(reasonFor(VALID.replace("adapter: claude-code", "adapter: opencode")))
        .toContain("claude-code");
    });

    it("rejects an unknown billing kind", () => {
      expect(reasonFor(VALID.replace("billing: subscription", "billing: free")))
        .toContain("subscription, metered");
    });

    it("rejects a lane missing a tier", () => {
      // A lane that cannot answer "what is light here?" would degrade to
      // nothing under the quota ladder.
      expect(reasonFor(VALID.replace("      light: haiku\n", ""))).toContain(
        '"light" tier'
      );
    });

    it("rejects a lane mapping a tier that does not exist", () => {
      expect(reasonFor(VALID.replace("light: haiku", "light: haiku\n      tiny: nano")))
        .toContain("tiny");
    });

    it("rejects a lane with no auth at all", () => {
      expect(
        reasonFor(
          VALID.replace(
            "    auth:\n      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_CODE_OAUTH_TOKEN\n",
            ""
          )
        )
      ).toContain("auth");
    });

    it("rejects a non-https base URL", () => {
      expect(
        reasonFor(VALID.replace("https://api.anthropic.com/", "http://api.internal"))
      ).toContain("https://");
    });

    it("rejects a non-positive daily cap", () => {
      expect(reasonFor(VALID.replace("daily_budget_usd: 20", "daily_budget_usd: 0")))
        .toContain("positive number");
    });

    it("rejects a duplicate lane id", () => {
      expect(reasonFor(VALID.replace("id: anthropic-api", "id: claude-subscription")))
        .toContain("duplicate lane id");
    });

    it("rejects a primary naming a lane that is not declared", () => {
      expect(reasonFor(VALID.replace("  - anthropic-api", "  - kimi"))).toContain(
        "not declared"
      );
    });

    it("rejects an empty or unreadable document", () => {
      expect(reasonFor("")).toContain("mapping");
      expect(reasonFor("lanes: []")).toContain("non-empty list");
      expect(reasonFor("lanes: [{id: a, adapter: claude-code, billing: metered, auth: {A: B}, models: {heavy: x, standard: y, light: z}}]"))
        .toContain("`primary`");
      expect(reasonFor("lanes: [\n")).toContain("invalid YAML");
    });
  });
});

/**
 * The file this repo actually ships. Parsed here rather than only in
 * production, because "the checked-in lane config is valid" is the single
 * assumption every pass rests on — a typo in it takes the whole fleet down and
 * nothing else in the suite would notice.
 */
describe("the shipped lanes.yaml", () => {
  const text = fs.readFileSync(
    path.join(process.cwd(), LANE_CONFIG_FILE),
    "utf8"
  );
  const catalog = parse(text);

  it("declares the subscription lane first in preference order", () => {
    // A deployment must never *default* onto a lane that spends real money at
    // a third party; only an explicit choice may take it there.
    expect(catalog.preference[0]).toBe("claude-subscription");
    const preferred = catalog.preference.map(
      (id) => catalog.lanes.find((lane) => lane.id === id)!
    );
    expect(preferred.map((lane) => lane.baseUrl)).toEqual([null, null]);
  });

  it("runs every lane on the one adapter that ships", () => {
    expect(catalog.lanes.map((lane) => lane.adapter)).toEqual(
      catalog.lanes.map(() => "claude-code")
    );
    expect(laneIds(catalog).length).toBeGreaterThan(1);
  });

  it("reproduces the pre-lane model mapping on the subscription lane", () => {
    // "All existing passes run through it unchanged" is a fact about these
    // three values: they are what every pass has run on since issue #74.
    const subscription = catalog.lanes.find(
      (lane) => lane.id === "claude-subscription"
    )!;
    expect(subscription.models).toEqual({
      heavy: "opus",
      standard: "sonnet",
      light: "haiku",
    });
    expect(subscription.billing).toBe("subscription");
  });

  it("declares a daily cap on every metered lane", () => {
    for (const lane of catalog.lanes.filter((l) => l.billing === "metered")) {
      expect(lane.caps.dailyBudgetUsd).toBeGreaterThan(0);
    }
  });

  it("names the OpenRouter credential exactly as it is provisioned", () => {
    const openrouter = catalog.lanes.find((lane) => lane.id === "openrouter")!;
    expect(openrouter.auth).toEqual([
      { harnessVar: "ANTHROPIC_AUTH_TOKEN", fromEnv: "OPENROUTER_API_KEY" },
    ]);
  });

  it("contains no value that could be a secret", () => {
    // Belt and braces over the parser's own rule: the file is version
    // controlled, so a credential in it is a credential in git forever.
    expect(text).not.toMatch(/sk-[a-z]/i);
    for (const lane of catalog.lanes) {
      for (const ref of lane.auth) {
        expect(ref.fromEnv).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
  });
});
