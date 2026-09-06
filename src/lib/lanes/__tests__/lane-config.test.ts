import fs from "fs";
import path from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { parseLaneConfig, laneIds, laneReportsQuota } from "../lane-config";
import { LANE_CONFIG_FILE } from "../catalog";
import { choosePrimaryLane, laneIsAvailable, laneMissingEnv } from "../resolve";
import {
  HARNESS_ADAPTER_DESCRIPTORS,
  describeHarnessAdapter,
  type HarnessAdapterDescriptor,
} from "@/lib/harness/descriptors";
import { DESCRIPTORS_WITH_FAKE, fakeHarnessDescriptor } from "@/test/fake-harness";

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
      // The adapter's declared capabilities ride on the lane (issue #219), so
      // no reader downstream has to look the adapter up to know them.
      capabilities: {
        userInvokedSkills: true,
        quotaTelemetry: true,
        reportsCost: true,
        sessionResume: true,
      },
      billing: "subscription",
      auth: [
        { harnessVar: "CLAUDE_CODE_OAUTH_TOKEN", fromEnv: "CLAUDE_CODE_OAUTH_TOKEN" },
      ],
      baseUrl: null,
      models: { heavy: "opus", standard: "sonnet", light: "haiku" },
      prices: null,
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

    it("rejects an unknown harness adapter, naming the described ones", () => {
      expect(reasonFor(VALID.replace("adapter: claude-code", "adapter: no-such-harness")))
        .toContain("claude-code");
    });

    it("accepts an adapter only when the descriptor table it is handed describes it (issue #214)", () => {
      // The parser's list of adapters is the descriptor table, shared with the
      // registry; a test may describe the fake adapter to it, and the
      // production table never does.
      const onFake = VALID.replace("adapter: claude-code", "adapter: fake");
      expect(reasonFor(onFake)).toContain('names adapter "fake"');
      expect(reasonFor(onFake)).toContain("claude-code");
      const result = parseLaneConfig(onFake, DESCRIPTORS_WITH_FAKE);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.catalog.lanes[0].adapter).toBe("fake");
      }
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

  it("names the plan the subscription lane is on, under the id the ledger records", () => {
    // The label is what the screen shows and moves with the plan (issue
    // #211); the id is on every ledger row and in the stored primary-lane
    // override, so it may not.
    const subscription = catalog.lanes.find(
      (lane) => lane.id === "claude-subscription"
    )!;
    expect(subscription.label).toBe("Claude subscription (Pro)");
  });

  it("runs every lane on one of the three adapters that ship, and names all three", () => {
    // The Claude lanes all run Claude Code; the Codex lanes (issue #221) and
    // the OpenCode lane (issue #222) run the other two. Every adapter a lane
    // names is a described one — the parser refused the file otherwise — and
    // every adapter that ships is in use.
    const adapters = new Set(catalog.lanes.map((lane) => lane.adapter));
    expect([...adapters].sort()).toEqual(["claude-code", "codex", "opencode"]);
    for (const lane of catalog.lanes) {
      expect(lane.capabilities).toEqual(describeHarnessAdapter(lane.adapter)!.capabilities);
    }
    expect(laneIds(catalog).length).toBeGreaterThan(1);
  });

  describe("the Codex lanes (issue #221)", () => {
    const lane = (id: string) => catalog.lanes.find((l) => l.id === id)!;
    const codex = describeHarnessAdapter("codex")!.capabilities;

    it("declares one lane for the ChatGPT plan and one for the API, both on the codex adapter", () => {
      const subscription = lane("codex-subscription");
      expect(subscription.adapter).toBe("codex");
      expect(subscription.billing).toBe("subscription");
      // The documented CI credential is a seeded auth.json; the variable holds
      // its contents and the adapter materialises it per exec.
      expect(subscription.auth).toEqual([
        { harnessVar: "CODEX_AUTH_JSON", fromEnv: "CODEX_AUTH_JSON" },
      ]);
      expect(subscription.baseUrl).toBeNull();
      expect(subscription.prices).toBeNull();

      const api = lane("openai-api");
      expect(api.adapter).toBe("codex");
      expect(api.billing).toBe("metered");
      // The CLI reads CODEX_API_KEY (OPENAI_API_KEY alone sends no bearer);
      // the secret is provisioned under its natural name.
      expect(api.auth).toEqual([{ harnessVar: "CODEX_API_KEY", fromEnv: "OPENAI_API_KEY" }]);
      expect(api.baseUrl).toBeNull();
      expect(api.caps.dailyBudgetUsd).toBeGreaterThan(0);
    });

    it("carries the codex adapter's capabilities: no quota telemetry, no cost, resume, skills (#224)", () => {
      for (const id of ["codex-subscription", "openai-api"]) {
        expect(lane(id).capabilities).toEqual(codex);
      }
      expect(codex).toEqual({
        userInvokedSkills: true,
        quotaTelemetry: false,
        reportsCost: false,
        sessionResume: true,
      });
      expect(laneReportsQuota(lane("codex-subscription"))).toBe(false);
    });

    it("prices every tier of the metered Codex lane, as a harness that reports no cost requires", () => {
      const api = lane("openai-api");
      expect(api.prices).not.toBeNull();
      for (const tier of ["heavy", "standard", "light"] as const) {
        expect(api.prices![tier].inputPerMTok).toBeGreaterThan(0);
        expect(api.prices![tier].outputPerMTok).toBeGreaterThan(0);
        expect(api.prices![tier].cacheReadPerMTok).toBeGreaterThan(0);
        expect(api.prices![tier].cacheWritePerMTok).toBeGreaterThan(0);
      }
      // The rule, live on this file: strip the prices and the parser refuses it.
      const doc = parseYaml(text) as { lanes: Array<{ id: string; prices?: unknown }> };
      const openai = doc.lanes.find((l) => l.id === "openai-api")!;
      expect(openai.prices).toBeDefined();
      delete openai.prices;
      const result = parseLaneConfig(stringifyYaml(doc));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('"codex"');
    });

    it("maps both Codex lanes onto the same GPT-5 family, tier for tier", () => {
      const subscription = lane("codex-subscription");
      const api = lane("openai-api");
      expect(api.models).toEqual(subscription.models);
      for (const tier of ["heavy", "standard", "light"] as const) {
        expect(subscription.models[tier]).toMatch(/^gpt-5/);
      }
    });

    it("keeps both out of the default preference, so a deployment never defaults onto them", () => {
      expect(catalog.preference).not.toContain("codex-subscription");
      expect(catalog.preference).not.toContain("openai-api");
    });

    it("leaves both unavailable when their credentials are absent", () => {
      expect(laneMissingEnv(lane("codex-subscription"), {})).toEqual(["CODEX_AUTH_JSON"]);
      expect(laneMissingEnv(lane("openai-api"), {})).toEqual(["OPENAI_API_KEY"]);
      // And the fleet's default primary is untouched by their presence in the
      // file: the preference walk still lands on the Claude subscription.
      const choice = choosePrimaryLane({
        catalog,
        override: null,
        envLane: null,
        env: { CLAUDE_CODE_OAUTH_TOKEN: "set" },
      });
      expect(choice).toMatchObject({ laneId: "claude-subscription", source: "preference" });
    });
  });

  describe("the OpenCode lane (issue #222)", () => {
    const lane = catalog.lanes.find((l) => l.id === "opencode-openrouter-glm")!;
    const sibling = catalog.lanes.find((l) => l.id === "openrouter-glm")!;

    it("runs the opencode adapter, metered, on the same credential as its Claude Code neighbour", () => {
      expect(lane.adapter).toBe("opencode");
      expect(lane.billing).toBe("metered");
      // OpenCode reads OPENROUTER_API_KEY as-is, so the harness variable and
      // the orchestrator variable coincide — the same secret the Claude Code
      // lane maps onto ANTHROPIC_AUTH_TOKEN.
      expect(lane.auth).toEqual([{ harnessVar: "OPENROUTER_API_KEY", fromEnv: "OPENROUTER_API_KEY" }]);
      expect(sibling.auth.map((ref) => ref.fromEnv)).toEqual(["OPENROUTER_API_KEY"]);
      // No base_url: OpenCode's own OpenRouter provider is the endpoint.
      expect(lane.baseUrl).toBeNull();
      expect(lane.caps.dailyBudgetUsd).toBeGreaterThan(0);
    });

    it("pins the same GLM models as the Claude Code lane, in OpenCode's provider/model form", () => {
      for (const tier of ["heavy", "standard", "light"] as const) {
        expect(lane.models[tier]).toBe(`openrouter/${sibling.models[tier]}`);
      }
    });

    it("carries the opencode adapter's capabilities: no quota telemetry, no cost, resume, skills (proven on #225)", () => {
      expect(lane.capabilities).toEqual(describeHarnessAdapter("opencode")!.capabilities);
      expect(lane.capabilities).toEqual({
        userInvokedSkills: true,
        quotaTelemetry: false,
        reportsCost: false,
        sessionResume: true,
      });
      expect(laneReportsQuota(lane)).toBe(false);
    });

    it("prices every tier — at the Claude Code lane's prices, since it is the same model on the same provider", () => {
      expect(lane.prices).toEqual(sibling.prices);
      for (const tier of ["heavy", "standard", "light"] as const) {
        expect(lane.prices![tier].inputPerMTok).toBeGreaterThan(0);
        expect(lane.prices![tier].outputPerMTok).toBeGreaterThan(0);
      }
      // The rule, live on this file (issue #219): a metered lane on a harness
      // that reports no cost is refused without them.
      const doc = parseYaml(text) as { lanes: Array<{ id: string; prices?: unknown }> };
      const opencode = doc.lanes.find((l) => l.id === "opencode-openrouter-glm")!;
      delete opencode.prices;
      const result = parseLaneConfig(stringifyYaml(doc));
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toMatch(/opencode.*reports no cost.*prices/);
    });

    it("is unavailable when the OpenRouter key is absent, and available when it is set", () => {
      expect(laneMissingEnv(lane, {})).toEqual(["OPENROUTER_API_KEY"]);
      expect(laneIsAvailable(lane, { ANTHROPIC_API_KEY: "sk-ant-x" })).toBe(false);
      expect(laneIsAvailable(lane, { OPENROUTER_API_KEY: "sk-or-x" })).toBe(true);
    });

    it("is not in the primary preference — nothing routes here until chosen", () => {
      expect(catalog.preference).not.toContain("opencode-openrouter-glm");
    });
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

  it("prices every lane that is not Anthropic-direct", () => {
    // The rule issue #175 exists for: off an Anthropic-direct endpoint the
    // CLI's reported cost is Anthropic list prices applied to a model that was
    // never billed at them (measured: $0.194985 for a turn on a free model).
    // A lane with a base_url and no prices would charge the fleet that number.
    for (const lane of catalog.lanes) {
      if (lane.baseUrl === null) continue;
      expect(lane.prices, `lane "${lane.id}" declares no prices`).not.toBeNull();
    }
  });

  it("carries the OpenRouter credential on more than one lane, unduplicated", () => {
    // The ticket's own thesis, as a fact about the file: changing *model* on a
    // third-party provider is a tier-map edit, not a new credential — and
    // since issue #222 changing *harness* is an adapter edit, not one either.
    const openrouterLanes = catalog.lanes.filter((lane) =>
      lane.auth.some((ref) => ref.fromEnv === "OPENROUTER_API_KEY")
    );
    expect(openrouterLanes.length).toBeGreaterThan(2);
    // The Claude Code lanes share the skin's one base URL; the OpenCode lane
    // reaches the same provider through the harness's own endpoint.
    const claude = openrouterLanes.filter((lane) => lane.adapter === "claude-code");
    expect(claude.length).toBeGreaterThan(1);
    expect(new Set(claude.map((lane) => lane.baseUrl)).size).toBe(1);
    expect(openrouterLanes.some((lane) => lane.adapter === "opencode")).toBe(true);
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

/**
 * The rules that follow the adapter's declared capabilities (issue #219): which
 * adapters a lane may name at all, and what a lane on a harness that reports
 * no cost must declare before it may bill per token.
 */
describe("parseLaneConfig — adapter capabilities (issue #219)", () => {
  /** A harness that reports nothing — no cost, no quota — as a second adapter
   * would look to the parser. Described only to the tests here. */
  const SILENT: HarnessAdapterDescriptor = {
    id: "silent",
    capabilities: {
      userInvokedSkills: false,
      quotaTelemetry: false,
      reportsCost: false,
      sessionResume: false,
    },
  };
  const DESCRIPTORS = [...HARNESS_ADAPTER_DESCRIPTORS, SILENT, fakeHarnessDescriptor];

  /** VALID's metered lane, moved onto the silent harness. */
  const METERED_ON_SILENT = VALID.replace(
    "  - id: anthropic-api\n    adapter: claude-code\n    billing: metered",
    "  - id: anthropic-api\n    adapter: silent\n    billing: metered"
  );
  const PRICES = `    prices:
      heavy: { input: 1, output: 4 }
      standard: { input: 0.5, output: 2 }
      light: { input: 0.1, output: 0.4 }
`;

  function refusal(text: string): string {
    const result = parseLaneConfig(text, DESCRIPTORS);
    expect(result.ok).toBe(false);
    return result.ok ? "" : result.reason;
  }

  it("refuses an adapter the table does not describe, naming every registered id", () => {
    // The whole vocabulary, so a typo is corrected from the reason rather than
    // from the source: with the fake described, both ids are listed.
    const reason = refusal(VALID.replace("adapter: claude-code", "adapter: gemini"));

    expect(reason).toContain('names adapter "gemini"');
    expect(reason).toContain("not a registered harness adapter");
    expect(reason).toContain("claude-code");
    expect(reason).toContain("codex");
    expect(reason).toContain("silent");
    expect(reason).toContain("fake");
  });

  it("refuses a metered lane on a harness that reports no cost unless every tier is priced", () => {
    // Real money on a harness that produces no dollar figure: without prices
    // the fleet would book its spend from nothing. The reason names the
    // adapter and the rule, so the fix is readable from it.
    const reason = refusal(METERED_ON_SILENT);

    expect(reason).toContain('lane "anthropic-api"');
    expect(reason).toContain('"silent"');
    expect(reason).toContain("reports no cost");
    expect(reason).toContain("prices");
    expect(reason).toContain("heavy, standard, light");
  });

  it("accepts the same lane once it prices every tier", () => {
    const priced = METERED_ON_SILENT.replace(
      "    caps:\n      daily_budget_usd: 20",
      PRICES + "    caps:\n      daily_budget_usd: 20"
    );

    const result = parseLaneConfig(priced, DESCRIPTORS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lane = result.catalog.lanes.find((l) => l.id === "anthropic-api")!;
    expect(lane.adapter).toBe("silent");
    expect(lane.prices?.light.inputPerMTok).toBe(0.1);
    expect(lane.capabilities).toEqual(SILENT.capabilities);
  });

  it("accepts the same lane declared subscription, with no prices at all", () => {
    // Its marginal cash cost is zero: tokens are still recorded and nothing is
    // booked to metered spend, so there is no figure to get wrong.
    const result = parseLaneConfig(
      METERED_ON_SILENT.replace(
        "adapter: silent\n    billing: metered",
        "adapter: silent\n    billing: subscription"
      ),
      DESCRIPTORS
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lane = result.catalog.lanes.find((l) => l.id === "anthropic-api")!;
    expect(lane.billing).toBe("subscription");
    expect(lane.prices).toBeNull();
  });

  it("leaves a metered Claude Code lane without prices exactly as before", () => {
    // Claude Code reports cost, so the Anthropic-direct lane may keep taking the
    // harness's own figure — the rule is keyed on the capability, never on the
    // billing kind alone or on the endpoint.
    const result = parseLaneConfig(VALID, DESCRIPTORS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const api = result.catalog.lanes.find((l) => l.id === "anthropic-api")!;
    expect(api.billing).toBe("metered");
    expect(api.prices).toBeNull();
    expect(api.capabilities.reportsCost).toBe(true);
  });

  it("says whether a lane's harness reports quota, and answers no lane cautiously", () => {
    const result = parseLaneConfig(METERED_ON_SILENT.replace(
      "adapter: silent\n    billing: metered",
      "adapter: silent\n    billing: subscription"
    ), DESCRIPTORS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [claude, silent] = result.catalog.lanes;

    expect(laneReportsQuota(claude)).toBe(true);
    expect(laneReportsQuota(silent)).toBe(false);
    // No lane is not a lane the fleet can attribute telemetry to.
    expect(laneReportsQuota(null)).toBe(false);
  });
});

/**
 * Lane prices (issue #175) — the numbers a metered lane's spend is actually
 * derived from, so the parser is as strict about them as it is about auth.
 */
describe("parseLaneConfig — prices", () => {
  function withPrices(prices: string): string {
    return VALID.replace(
      `    caps:
      daily_budget_usd: 20`,
      prices
    );
  }

  it("reads a priced tier into USD per million tokens", () => {
    const catalog = parse(
      withPrices(`    prices:
      heavy: { input: 1.4, output: 4.4, cache_read: 0.26 }
      standard: { input: 0.075, output: 0.25, cache_read: 0.015 }
      light: { input: 0.06, output: 0.4, cache_read: 0.01, cache_write: 0.5 }`)
    );
    const lane = catalog.lanes.find((l) => l.id === "anthropic-api")!;

    expect(lane.prices?.standard).toEqual({
      inputPerMTok: 0.075,
      outputPerMTok: 0.25,
      cacheReadPerMTok: 0.015,
      // Absent is null, not zero: the cost calculation reads it as the input
      // rate, because a provider publishing no cache price charges full price.
      cacheWritePerMTok: null,
    });
    expect(lane.prices?.light.cacheWritePerMTok).toBe(0.5);
  });

  it("takes no prices at all as an intentional choice, not an omission", () => {
    // An Anthropic-direct lane: the harness's own figure is the right one
    // there, and re-declaring list prices would create a second copy to rot.
    const catalog = parse(VALID);
    expect(catalog.lanes.every((lane) => lane.prices === null)).toBe(true);
  });

  it("refuses prices that cover only some tiers", () => {
    // A lane that could price `standard` but not `light` would fall silently
    // back to the untrusted harness figure the moment the degrade ladder
    // stepped down — the one moment nobody is watching the number.
    const reason = reasonFor(
      withPrices(`    prices:
      heavy: { input: 1.4, output: 4.4 }
      standard: { input: 0.075, output: 0.25 }`)
    );
    expect(reason).toContain('"light"');
  });

  it("refuses a negative price and a non-numeric one", () => {
    expect(
      reasonFor(
        withPrices(`    prices:
      heavy: { input: -1, output: 4.4 }
      standard: { input: 0.075, output: 0.25 }
      light: { input: 0.06, output: 0.4 }`)
      )
    ).toContain("prices.heavy.input");

    expect(
      reasonFor(
        withPrices(`    prices:
      heavy: { input: cheap, output: 4.4 }
      standard: { input: 0.075, output: 0.25 }
      light: { input: 0.06, output: 0.4 }`)
      )
    ).toContain("prices.heavy.input");
  });

  it("accepts a zero price — a free model really is free", () => {
    const catalog = parse(
      withPrices(`    prices:
      heavy: { input: 0, output: 0 }
      standard: { input: 0, output: 0 }
      light: { input: 0, output: 0 }`)
    );
    expect(
      catalog.lanes.find((l) => l.id === "anthropic-api")!.prices?.heavy
        .inputPerMTok
    ).toBe(0);
  });

  it("refuses a tier it does not know, exactly as `models` does", () => {
    const reason = reasonFor(
      withPrices(`    prices:
      heavy: { input: 1, output: 1 }
      standard: { input: 1, output: 1 }
      light: { input: 1, output: 1 }
      medium: { input: 1, output: 1 }`)
    );
    expect(reason).toContain("medium");
  });
});
