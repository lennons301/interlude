import { describe, it, expect, vi } from "vitest";
import { isGenerationSession, SESSION_SKILLS, type SessionSkill } from "@/db/schema";
import type { ResolvedLane } from "@/lib/lanes/resolve";

// The adapter's output handler writes into the feed; nothing here exercises it,
// so the DB is stubbed rather than opened.
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/config", () => ({
  getConfig: () => ({ maxTurns: 50, maxBudgetUsd: 20 }),
}));

import {
  buildTurnEnv,
  buildClaudeTurnCommand,
  claudeCodeAdapter,
  composeClaudeSkillInvocation,
  mapClaudeEffort,
  CLAUDE_CODE_BASE_URL_ENV,
} from "../claude-code";
import { CLAUDE_CODE_IMAGE } from "../claude-code/image";
import { getHarnessAdapter } from "../registry";
import { describeHarnessAdapter } from "../descriptors";
import { ALLOWED_TICKET_EFFORTS } from "@/lib/orchestrator/autonomy/budgets";
import { containerTranscriptPath } from "@/lib/quota/session-transcript";
import { getImageName } from "@/lib/docker/image-builder";
import { composeSeed } from "@/lib/sessions/seed";

/**
 * The Claude Code adapter (issues #74, #81, #172): what one turn's exec
 * environment and command are built from. These were the container manager's
 * builders before lanes; the assertions they carried are kept verbatim, and
 * what is new is that the auth, the endpoint and the model identifier all
 * arrive from a *resolved lane* rather than from `getConfig()`.
 */

/** The default subscription lane, as the resolver would hand it over. */
function lane(overrides: Partial<ResolvedLane> = {}): ResolvedLane {
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
    auth: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" },
    baseUrl: null,
    tier: "heavy",
    model: "opus",
    prices: null,
    declaresPrices: false,
    caps: { dailyBudgetUsd: null },
    ...overrides,
  };
}

describe("buildTurnEnv", () => {
  it("always carries the prompt and git auth token", () => {
    const env = buildTurnEnv({
      prompt: "do the thing",
      gitAuthToken: "ghs_abc",
      ghToken: null,
      lane: lane(),
    });
    expect(env).toContain("CLAUDE_PROMPT=do the thing");
    expect(env).toContain("GIT_AUTH_TOKEN=ghs_abc");
  });

  it("injects whichever auth variables the lane names", () => {
    const env = buildTurnEnv({
      prompt: "p",
      gitAuthToken: "t",
      ghToken: null,
      lane: lane({ auth: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-xyz" } }),
    });
    expect(env).toContain("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xyz");
  });

  // The point of a lane: another provider is a different variable and a
  // different endpoint under the *same* adapter.
  it("injects a different lane's auth variable and base URL (issue #172)", () => {
    const env = buildTurnEnv({
      prompt: "p",
      gitAuthToken: "t",
      ghToken: null,
      lane: lane({
        id: "openrouter",
        billing: "metered",
        auth: { ANTHROPIC_AUTH_TOKEN: "sk-or-v1-test" },
        baseUrl: "https://openrouter.ai/api",
      }),
    });
    expect(env).toContain("ANTHROPIC_AUTH_TOKEN=sk-or-v1-test");
    expect(env).toContain(`${CLAUDE_CODE_BASE_URL_ENV}=https://openrouter.ai/api`);
    // Only the chosen lane's variables — two credentials must never race to
    // authenticate one turn.
    expect(env.some((e) => e.startsWith("CLAUDE_CODE_OAUTH_TOKEN"))).toBe(false);
  });

  it("omits the base URL entirely when the lane names none", () => {
    const env = buildTurnEnv({
      prompt: "p",
      gitAuthToken: "t",
      ghToken: null,
      lane: lane({ baseUrl: null }),
    });
    expect(env.some((e) => e.startsWith(CLAUDE_CODE_BASE_URL_ENV))).toBe(false);
  });

  it("carries no auth at all for a lane with none", () => {
    const env = buildTurnEnv({
      prompt: "p",
      gitAuthToken: "t",
      ghToken: null,
      lane: lane({ auth: {} }),
    });
    expect(env).toEqual(["CLAUDE_PROMPT=p", "GIT_AUTH_TOKEN=t"]);
  });

  // Issue #62: `gh` inside a generation-session container authenticates from
  // GH_TOKEN. It is exposed only when the caller passes a token — for autonomous
  // execs the caller passes null, so the negative case is that GH_TOKEN is simply
  // never in the env.
  it("exposes GH_TOKEN to gh when a generation-session token is supplied", () => {
    const env = buildTurnEnv({
      prompt: "p",
      gitAuthToken: "ghs_git",
      ghToken: "ghs_gh",
      lane: lane(),
    });
    expect(env).toContain("GH_TOKEN=ghs_gh");
  });

  it("omits GH_TOKEN entirely when no generation-session token is supplied", () => {
    const env = buildTurnEnv({
      prompt: "p",
      gitAuthToken: "ghs_git",
      ghToken: null,
      lane: lane(),
    });
    expect(env.some((e) => e.startsWith("GH_TOKEN"))).toBe(false);
  });
});

// Issue #62: the exec-config wiring — a generation session (interactive task
// with a sessionSkill) receives the App token as GH_TOKEN; every autonomous kind
// receives none. This mirrors runTurn's `isGenerationSession(task) ? token
// : null`, testing the predicate and the env builder as one path. The negative
// assertions for implement/review/triage are the isolation boundary from #62,
// and issue #172 must not have widened it by moving the builder.
describe("GH_TOKEN injection is gated on generation sessions (issue #62)", () => {
  const APP_TOKEN = "ghs_installation";

  const envFor = (task: { kind: string; sessionSkill: SessionSkill | null }) =>
    buildTurnEnv({
      prompt: "p",
      gitAuthToken: APP_TOKEN,
      ghToken: isGenerationSession(task) ? APP_TOKEN : null,
      lane: lane(),
    });

  it("injects GH_TOKEN for a generation-session exec", () => {
    for (const sessionSkill of SESSION_SKILLS) {
      const env = envFor({ kind: "interactive", sessionSkill });
      expect(env).toContain(`GH_TOKEN=${APP_TOKEN}`);
    }
  });

  it("withholds GH_TOKEN from every autonomous kind", () => {
    // The isolation boundary is per-kind: no unattended exec may hold an
    // issue-writing token, so `repair` is asserted alongside implement/review/
    // triage even though #62 names only the latter three.
    for (const kind of ["implement", "review", "triage", "repair"] as const) {
      const env = envFor({ kind, sessionSkill: null });
      expect(env.some((e) => e.startsWith("GH_TOKEN"))).toBe(false);
    }
  });

  it("withholds GH_TOKEN from an ordinary chat task (no session skill)", () => {
    const env = envFor({ kind: "interactive", sessionSkill: null });
    expect(env.some((e) => e.startsWith("GH_TOKEN"))).toBe(false);
  });
});

describe("buildClaudeTurnCommand", () => {
  it("runs Claude with stream-json and the configured limits", () => {
    const cmd = buildClaudeTurnCommand({ lane: lane({ model: null }) });
    expect(cmd).toContain("cd /workspace/repo");
    expect(cmd).toContain("claude -p");
    expect(cmd).toContain("--output-format stream-json");
    expect(cmd).toContain("--max-turns 50");
    expect(cmd).toContain("--max-budget-usd 20");
  });

  it("prefers per-exec budget and turn overrides over the config defaults", () => {
    const cmd = buildClaudeTurnCommand({
      lane: lane(),
      maxTurns: 100,
      maxBudgetUsd: 75,
    });
    expect(cmd).toContain("--max-turns 100");
    expect(cmd).toContain("--max-budget-usd 75");
  });

  it("gives no spend ceiling to a lane whose prices the CLI does not know", () => {
    // Issue #175: `--max-budget-usd` is enforced against the CLI's own cost
    // figure, which off an Anthropic-direct endpoint is Anthropic list prices
    // applied to a model that was never billed at them — measured at 67x the
    // lane's real price. A $20 ceiling would stop the turn at about $0.30 of
    // real spend, mid-work, and the orchestrator would park the pass as
    // finished because a budget stop is not `error_max_turns`.
    const cmd = buildClaudeTurnCommand({
      maxBudgetUsd: 20,
      lane: lane({
        id: "openrouter-glm",
        model: "z-ai/glm-5.3-flash",
        declaresPrices: true,
        prices: {
          inputPerMTok: 0.075,
          outputPerMTok: 0.25,
          cacheReadPerMTok: 0.015,
          cacheWritePerMTok: null,
        },
      }),
    });

    expect(cmd).not.toContain("--max-budget-usd");
    // What still bounds the turn: the turn ceiling here, and the fleet's own
    // accounting between turns, which charges the lane's real prices.
    expect(cmd).toContain("--max-turns 50");
  });

  it("gives no ceiling to a priced lane even when no tier resolved", () => {
    // The pinned-model case: `AGENT_MODEL` names a raw identifier, so no tier
    // resolves and there is no per-tier price to read — but the *provider* is
    // still one the CLI does not price, so the ceiling is still one it would
    // misapply. Keying this branch on the resolved `prices` rather than on the
    // lane definition put the invisible mid-work truncation straight back.
    const cmd = buildClaudeTurnCommand({
      maxBudgetUsd: 20,
      lane: lane({
        id: "openrouter-glm",
        tier: null,
        model: "some/pinned-model",
        declaresPrices: true,
        prices: null,
      }),
    });

    expect(cmd).not.toContain("--max-budget-usd");
  });

  it("keeps the ceiling on a lane whose reported cost is its own list price", () => {
    // The live path is untouched: the subscription lane declares no prices,
    // so the CLI's figure is correct there and the flag still guards a turn.
    const cmd = buildClaudeTurnCommand({ maxBudgetUsd: 20, lane: lane() });

    expect(cmd).toContain("--max-budget-usd 20");
  });

  it("omits --model entirely when the lane resolved none (issue #74)", () => {
    expect(buildClaudeTurnCommand({ lane: lane({ model: null }) })).not.toContain(
      "--model"
    );
  });

  it("pins the model the lane resolved (issues #74, #172)", () => {
    const cmd = buildClaudeTurnCommand({
      lane: lane({ model: "claude-sonnet-5" }),
    });
    expect(cmd).toContain("--model 'claude-sonnet-5'");
  });

  it("single-quotes the model so glob metacharacters stay literal (issue #74)", () => {
    const cmd = buildClaudeTurnCommand({
      lane: lane({ model: "claude-opus-4-8[1m]" }),
    });
    // The bracketed id must not be exposed to bash pathname expansion.
    expect(cmd).toContain("--model 'claude-opus-4-8[1m]'");
    expect(cmd).not.toContain("--model claude-opus-4-8[1m]");
  });

  it("carries a provider-slug model id from another lane intact (issue #172)", () => {
    const cmd = buildClaudeTurnCommand({
      lane: lane({ model: "anthropic/claude-sonnet-4.5" }),
    });
    expect(cmd).toContain("--model 'anthropic/claude-sonnet-4.5'");
  });

  it("omits --effort entirely when no level is pinned (issue #81)", () => {
    expect(buildClaudeTurnCommand({ lane: lane(), effort: null })).not.toContain(
      "--effort"
    );
    expect(buildClaudeTurnCommand({ lane: lane() })).not.toContain("--effort");
  });

  it("pins the reasoning effort with --effort when one is resolved (issue #81)", () => {
    const cmd = buildClaudeTurnCommand({ lane: lane(), effort: "high" });
    expect(cmd).toContain("--effort 'high'");
  });

  it("carries both --model and --effort together, independently (issue #81)", () => {
    const cmd = buildClaudeTurnCommand({
      lane: lane({ model: "claude-opus-4-8" }),
      effort: "max",
    });
    expect(cmd).toContain("--model 'claude-opus-4-8'");
    expect(cmd).toContain("--effort 'max'");
  });

  it("appends --resume for a follow-up turn", () => {
    const cmd = buildClaudeTurnCommand({ lane: lane(), sessionId: "sess-123" });
    expect(cmd).toContain("--resume sess-123");
  });

  it("never puts a credential on the command line", () => {
    // Auth travels in the exec environment, never in a `bash -c` string that
    // would land in `ps` output and the container's own shell history.
    const cmd = buildClaudeTurnCommand({
      lane: lane({ auth: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-secret" } }),
    });
    expect(cmd).not.toContain("sk-ant-oat01-secret");
  });
});

describe("the adapter registry (issue #172)", () => {
  it("resolves the one adapter that ships", () => {
    expect(getHarnessAdapter("claude-code")).toBe(claudeCodeAdapter);
  });

  it("throws rather than guessing at an adapter it does not have", () => {
    // A lane naming an unknown adapter is a config error the parser already
    // refuses; reaching here means the two drifted, and guessing would run the
    // pass on a harness nobody chose.
    expect(() => getHarnessAdapter("opencode")).toThrow(/no harness adapter/);
  });

  it("exposes the three functions a second adapter would have to replace", () => {
    expect(typeof claudeCodeAdapter.buildExecEnv).toBe("function");
    expect(typeof claudeCodeAdapter.buildCommand).toBe("function");
    expect(typeof claudeCodeAdapter.createOutputHandler).toBe("function");
  });
});

// Issue #214 widened the contract; each new member answers the way the fleet
// already behaved on the Claude lane, and these pin that.
describe("the widened contract on the Claude Code adapter (issue #214)", () => {
  it("declares the one image the fleet has always built, and the builder reads it", () => {
    expect(claudeCodeAdapter.image).toEqual(CLAUDE_CODE_IMAGE);
    expect(claudeCodeAdapter.image).toEqual({
      name: "interlude-agent:latest",
      dockerfile: "Dockerfile.agent",
    });
    expect(getImageName()).toBe(claudeCodeAdapter.image.name);
  });

  it("declares the capabilities its descriptor does — read from the table, not restated", () => {
    expect(claudeCodeAdapter.capabilities).toEqual(
      describeHarnessAdapter("claude-code")!.capabilities
    );
    expect(claudeCodeAdapter.capabilities).toEqual({
      userInvokedSkills: true,
      quotaTelemetry: true,
      reportsCost: true,
      sessionResume: true,
    });
  });

  it("maps every fleet effort level onto itself, and nothing else onto anything", () => {
    for (const level of ALLOWED_TICKET_EFFORTS) {
      expect(mapClaudeEffort(level)).toBe(level);
      expect(claudeCodeAdapter.mapEffort(level)).toBe(level);
    }
    expect(mapClaudeEffort("hihg")).toBeNull();
    expect(mapClaudeEffort("")).toBeNull();
  });

  it("omits --effort for a level it cannot map rather than passing a stranger's word", () => {
    // Unreachable from either entry point (both validate against the same
    // list), but the contract says "omitted, never guessed at" and the command
    // is where that is enforced.
    const cmd = buildClaudeTurnCommand({ lane: lane(), effort: "hihg" });
    expect(cmd).not.toContain("--effort");
  });

  it("composes a skill invocation byte-identical to the seed composer's slash line", () => {
    // Issue #218 makes the composer ask the adapter; until then this is the
    // guarantee that doing so changes nothing on the Claude lane.
    // Byte-identical to the slash the seed composer wrote itself before #218
    // made it ask the adapter: a seed composed for a Claude lane is the same
    // string it always was.
    expect(composeClaudeSkillInvocation("grill-me", "the auth flow")).toBe(
      "/grill-me the auth flow"
    );
    expect(
      composeSeed({ sessionSkill: "grill-me", agenda: "the auth flow" }, claudeCodeAdapter)
        .split("\n\n")[0]
    ).toBe("/grill-me the auth flow");
    expect(composeClaudeSkillInvocation("wayfinder", null)).toBe("/wayfinder");
    expect(composeSeed({ sessionSkill: "wayfinder" }, claudeCodeAdapter)).toBe("/wayfinder");
    expect(composeClaudeSkillInvocation("to-spec", "   ")).toBe("/to-spec");
    expect(claudeCodeAdapter.composeSkillInvocation("to-tickets", "batch 3")).toBe(
      "/to-tickets batch 3"
    );
  });

  it("names the one transcript file as the session's artefact, at the path the pause copies", () => {
    expect(claudeCodeAdapter.sessionArtifactPaths("sess-1", "/workspace/repo")).toEqual([
      containerTranscriptPath("sess-1", "/workspace/repo"),
    ]);
    expect(claudeCodeAdapter.sessionArtifactPaths("sess-1", "/workspace/repo")).toEqual([
      "/home/node/.claude/projects/-workspace-repo/sess-1.jsonl",
    ]);
  });
});
