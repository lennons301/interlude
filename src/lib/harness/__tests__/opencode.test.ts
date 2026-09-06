import { describe, it, expect, vi } from "vitest";
import type { ResolvedLane } from "@/lib/lanes/resolve";

// The adapter's output handler writes into the feed; nothing here exercises it,
// so the DB is stubbed rather than opened. The registry pulls Claude Code in
// too, whose command builder reads the config.
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/config", () => ({
  getConfig: () => ({ maxTurns: 50, maxBudgetUsd: 20 }),
}));

import {
  buildOpenCodeTurnCommand,
  buildOpenCodeTurnEnv,
  composeOpenCodeSkillInvocation,
  mapOpenCodeEffort,
  opencodeAdapter,
  opencodeSessionArtifactPaths,
  providerOf,
  OPENCODE_ADAPTER_ID,
  OPENCODE_BASE_URL_ENV,
  OPENCODE_CONFIG_ENV,
  OPENCODE_CONFIG_PATH,
  OPENCODE_DB_ENV,
  OPENCODE_DB_PATH,
  OPENCODE_PROMPT_ENV,
  OPENCODE_PROVIDER_ENV,
} from "../opencode";
import { OPENCODE_IMAGE } from "../opencode/image";
import { OPENCODE_TURN_EXIT_EVENT } from "../opencode/outcome";
import { getHarnessAdapter } from "../registry";
import { describeHarnessAdapter } from "../descriptors";
import { ALLOWED_TICKET_EFFORTS } from "@/lib/orchestrator/autonomy/budgets";
import { composeSeed, composeSessionTurn } from "@/lib/sessions/seed";

/**
 * The OpenCode adapter (issue #222): what one turn's exec environment and
 * command are built from, and the members of the seam #214 widened. Every
 * claim about the CLI here was measured on 1.18.29 in the built image — see
 * the module note in `../opencode/index.ts`.
 */

const KEY = "sk-or-v1-test-key";

/** The shipped OpenCode lane, as the resolver would hand it over. */
function lane(overrides: Partial<ResolvedLane> = {}): ResolvedLane {
  return {
    id: "opencode-openrouter-glm",
    label: "OpenRouter (GLM open weights) via OpenCode",
    adapter: OPENCODE_ADAPTER_ID,
    capabilities: {
      userInvokedSkills: false,
      quotaTelemetry: false,
      reportsCost: false,
      sessionResume: true,
    },
    billing: "metered",
    auth: { OPENROUTER_API_KEY: KEY },
    baseUrl: null,
    tier: "standard",
    model: "openrouter/z-ai/glm-5.3-flash",
    prices: { inputPerMTok: 0.075, outputPerMTok: 0.25, cacheReadPerMTok: 0.015, cacheWritePerMTok: null },
    declaresPrices: true,
    caps: { dailyBudgetUsd: 20 },
    ...overrides,
  };
}

const env = (overrides: Partial<Parameters<typeof buildOpenCodeTurnEnv>[0]> = {}) =>
  buildOpenCodeTurnEnv({
    prompt: "do the thing",
    gitAuthToken: "ghs_abc",
    ghToken: null,
    lane: lane(),
    ...overrides,
  });

describe("buildOpenCodeTurnEnv", () => {
  it("carries the prompt, the git token, and the CLI's database and config paths", () => {
    expect(env()).toEqual([
      `${OPENCODE_PROMPT_ENV}=do the thing`,
      "GIT_AUTH_TOKEN=ghs_abc",
      `${OPENCODE_DB_ENV}=${OPENCODE_DB_PATH}`,
      `${OPENCODE_CONFIG_ENV}=${OPENCODE_CONFIG_PATH}`,
      `OPENROUTER_API_KEY=${KEY}`,
    ]);
  });

  it("passes whichever auth variables the lane names, under the names the harness reads", () => {
    const built = env({ lane: lane({ auth: { ANTHROPIC_API_KEY: "sk-ant-x", OPENAI_API_KEY: "sk-y" } }) });
    expect(built).toContain("ANTHROPIC_API_KEY=sk-ant-x");
    expect(built).toContain("OPENAI_API_KEY=sk-y");
    expect(built.some((e) => e.startsWith("OPENROUTER_API_KEY"))).toBe(false);
  });

  it("names no base URL or provider when the lane declares none", () => {
    for (const entry of env()) {
      expect(entry.startsWith(OPENCODE_BASE_URL_ENV)).toBe(false);
      expect(entry.startsWith(OPENCODE_PROVIDER_ENV)).toBe(false);
    }
  });

  it("hands a declared base URL over with the provider the lane's model names (per-exec provider config)", () => {
    const built = env({ lane: lane({ baseUrl: "https://openrouter.ai/api/v1" }) });
    expect(built).toContain(`${OPENCODE_BASE_URL_ENV}=https://openrouter.ai/api/v1`);
    expect(built).toContain(`${OPENCODE_PROVIDER_ENV}=openrouter`);
  });

  it("names no provider for a pinned model id that carries none, so the CLI gets no half-override", () => {
    const built = env({ lane: lane({ baseUrl: "https://example.test", model: "glm-5.3-flash", tier: null }) });
    expect(built).toContain(`${OPENCODE_BASE_URL_ENV}=https://example.test`);
    expect(built.some((e) => e.startsWith(OPENCODE_PROVIDER_ENV))).toBe(false);
  });

  it("exposes GH_TOKEN only when a generation-session token is supplied (issue #62)", () => {
    expect(env({ ghToken: "ghs_gh" })).toContain("GH_TOKEN=ghs_gh");
    expect(env().some((e) => e.startsWith("GH_TOKEN"))).toBe(false);
  });
});

describe("providerOf", () => {
  it("reads the provider off the front of a provider/model id, keeping the model's own slash", () => {
    expect(providerOf("openrouter/z-ai/glm-5.3-flash")).toBe("openrouter");
    expect(providerOf("anthropic/claude-sonnet-4-5")).toBe("anthropic");
    expect(providerOf("glm-5.3-flash")).toBeNull();
    expect(providerOf("/glm")).toBeNull();
    expect(providerOf(null)).toBeNull();
  });
});

describe("buildOpenCodeTurnCommand", () => {
  const cmd = (input: Partial<Parameters<typeof buildOpenCodeTurnCommand>[0]> = {}) =>
    buildOpenCodeTurnCommand({ lane: lane(), ...input });

  it("runs opencode headless with JSON events, without plugins, pinned to the lane's model in provider/model form", () => {
    const built = cmd();
    expect(built).toContain(`cd /workspace/repo || exit 1`);
    expect(built).toContain("opencode run --format json --pure --model 'openrouter/z-ai/glm-5.3-flash'");
  });

  it("pipes the prompt from its environment variable rather than putting it on the command line", () => {
    const built = cmd();
    expect(built).toContain(`printf '%s' "$${OPENCODE_PROMPT_ENV}" | opencode run`);
    expect(built).not.toContain("do the thing");
  });

  it("puts no credential on the command line — auth reaches the CLI through the environment only", () => {
    const built = cmd();
    expect(built).not.toContain(KEY);
    expect(built).not.toContain("OPENROUTER_API_KEY");
    expect(built).not.toContain("--api-key");
  });

  it("passes no model flag when the lane resolves none", () => {
    expect(cmd({ lane: lane({ model: null, tier: null }) })).not.toContain("--model");
  });

  it("maps the fleet effort level onto --variant, and omits the flag when there is none", () => {
    expect(cmd({ effort: "high" })).toContain("--variant 'high'");
    expect(cmd({ effort: "max" })).toContain("--variant 'max'");
    expect(cmd({ effort: null })).not.toContain("--variant");
    expect(cmd()).not.toContain("--variant");
    // A level outside the fleet's vocabulary has no equivalent (unreachable
    // from either entry point, which validate against the same list).
    expect(cmd({ effort: "ludicrous" })).not.toContain("--variant");
  });

  it("continues a prior session with --session, and refuses an id the CLI could not have minted", () => {
    expect(cmd({ sessionId: "ses_f8c8647a3ffesld3PrZWwYuCz2" })).toContain(
      "--session 'ses_f8c8647a3ffesld3PrZWwYuCz2'"
    );
    expect(cmd()).not.toContain("--session");
    expect(() => cmd({ sessionId: "ses_x'; rm -rf /" })).toThrow(/Refusing to resume/);
  });

  it("writes the per-exec config — permissions allowed, the provider override only when a base URL is set", () => {
    const built = cmd();
    expect(built).toContain(`mkdir -p "$(dirname ${OPENCODE_CONFIG_PATH})"`);
    expect(built).toContain(`> ${OPENCODE_CONFIG_PATH}`);
    expect(built).toContain('{permission: {"*": "allow"}}');
    // Built by jq from the two variables the env builder sets, so the URL is a
    // JSON string whatever it contains, and the override is absent when either
    // is empty.
    expect(built).toContain(`--arg provider "\${${OPENCODE_PROVIDER_ENV}:-}"`);
    expect(built).toContain(`--arg url "\${${OPENCODE_BASE_URL_ENV}:-}"`);
    expect(built).toContain("{provider: {($provider): {options: {baseURL: $url}}}}");
    // The config is written before the CLI runs.
    expect(built.indexOf(OPENCODE_CONFIG_PATH)).toBeLessThan(built.indexOf("opencode run"));
  });

  it("checkpoints the session database after the CLI exits, then emits the adapter's terminal event last", () => {
    const built = cmd();
    const run = built.indexOf("opencode run");
    const checkpoint = built.indexOf("opencode db 'PRAGMA wal_checkpoint(TRUNCATE)'");
    const exit = built.indexOf(`"type":"${OPENCODE_TURN_EXIT_EVENT}"`);
    expect(run).toBeGreaterThan(-1);
    expect(checkpoint).toBeGreaterThan(run);
    expect(exit).toBeGreaterThan(checkpoint);
    expect(built).toContain("interlude_exit=$?");
    expect(built).toContain(`"exitCode":%d}\\n' "$interlude_exit"`);
    expect(built.trim().endsWith('"$interlude_exit"')).toBe(true);
    // Bounded: a checkpoint that hangs must not hold the slot.
    expect(built).toMatch(/timeout \d+ opencode db/);
  });

  it("has no turn or budget flag to pass, so the per-exec ceilings are accepted and ignored (issue #220 bounds the turn)", () => {
    const built = cmd({ maxTurns: 7, maxBudgetUsd: 3 });
    expect(built).not.toContain("--max");
    expect(built).not.toContain("7");
    expect(built).toBe(cmd());
  });
});

describe("mapOpenCodeEffort", () => {
  it("is the identity on the fleet's vocabulary — the CLI's variant names are these five", () => {
    for (const level of ALLOWED_TICKET_EFFORTS) {
      expect(mapOpenCodeEffort(level)).toBe(level);
      expect(opencodeAdapter.mapEffort(level)).toBe(level);
    }
  });

  it("has no equivalent for anything else", () => {
    expect(mapOpenCodeEffort("ludicrous")).toBeNull();
    expect(mapOpenCodeEffort("")).toBeNull();
  });
});

describe("composeOpenCodeSkillInvocation", () => {
  it("names the skill and tells the model to load it with the skill tool", () => {
    expect(composeOpenCodeSkillInvocation("wayfinder", null)).toBe(
      'Load the skill named "wayfinder" with the skill tool and follow it.'
    );
  });

  it("hands the agenda over as the skill's argument", () => {
    expect(composeOpenCodeSkillInvocation("to-spec", "focus on the auth flow")).toBe(
      'Load the skill named "to-spec" with the skill tool and follow it, taking this as its argument: focus on the auth flow'
    );
  });

  it("treats a blank agenda as none", () => {
    expect(composeOpenCodeSkillInvocation("to-spec", "   ")).toBe(
      composeOpenCodeSkillInvocation("to-spec", null)
    );
  });

  it("is what seed composition emits for this adapter, framing intact (issue #218)", () => {
    const seed = composeSeed(
      { sessionSkill: "to-spec", sessionIssue: "lennons301/interlude#42", agenda: "the new billing model" },
      opencodeAdapter
    );
    const [head, ...rest] = seed.split("\n\n");
    expect(head).toBe(composeOpenCodeSkillInvocation("to-spec", "the new billing model"));
    expect(rest.join("\n\n")).toContain("lennons301/interlude#42");
    expect(seed).not.toContain("/to-spec");
    // A typed slash on a follow-on turn reaches the agent as the same text.
    expect(composeSessionTurn("/grill-me the auth flow", opencodeAdapter)).toContain(
      composeOpenCodeSkillInvocation("grill-me", "the auth flow")
    );
  });
});

describe("session artefacts", () => {
  it("is the one database file, whatever the session id and working directory", () => {
    expect(opencodeSessionArtifactPaths()).toEqual([OPENCODE_DB_PATH]);
    expect(opencodeAdapter.sessionArtifactPaths("ses_abc", "/workspace/repo")).toEqual([OPENCODE_DB_PATH]);
    expect(opencodeAdapter.sessionArtifactPaths("ses_def", "/elsewhere")).toEqual([OPENCODE_DB_PATH]);
  });

  it("pins the database to that path in every turn's environment", () => {
    expect(env()).toContain(`${OPENCODE_DB_ENV}=${OPENCODE_DB_PATH}`);
  });
});

describe("the adapter", () => {
  it("is registered under its id with its descriptor's capabilities and its image", () => {
    expect(getHarnessAdapter(OPENCODE_ADAPTER_ID)).toBe(opencodeAdapter);
    expect(opencodeAdapter.id).toBe("opencode");
    expect(opencodeAdapter.image).toBe(OPENCODE_IMAGE);
    expect(OPENCODE_IMAGE).toEqual({
      name: "interlude-agent-opencode:latest",
      dockerfile: "Dockerfile.agent-opencode",
    });
    expect(opencodeAdapter.capabilities).toEqual(describeHarnessAdapter("opencode")!.capabilities);
  });

  it("states what it cannot do: no quota telemetry, no cost reporting, no user-invoked skills yet; it resumes a session", () => {
    expect(opencodeAdapter.capabilities).toEqual({
      userInvokedSkills: false,
      quotaTelemetry: false,
      reportsCost: false,
      sessionResume: true,
    });
  });

  it("builds through the same functions the tests above exercise", () => {
    expect(opencodeAdapter.buildExecEnv).toBe(buildOpenCodeTurnEnv);
    expect(opencodeAdapter.buildCommand).toBe(buildOpenCodeTurnCommand);
    expect(opencodeAdapter.composeSkillInvocation).toBe(composeOpenCodeSkillInvocation);
  });
});
