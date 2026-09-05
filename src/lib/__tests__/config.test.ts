import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getConfig,
  resetConfig,
  resolveAgentModelChoice,
  resolveAgentEffort,
  type AppConfig,
  type AgentPassKind,
} from "../config";
import type { SettingsOverrides } from "../settings-resolver";
import { ALLOWED_TICKET_EFFORTS } from "../orchestrator/autonomy/budgets";

/** No UI overrides stored — the state a fresh install is in, where every
 * field falls through to the environment. */
const NO_OVERRIDES: SettingsOverrides = {};

/**
 * What each tier means on the lane a pass would run on — here, the shipped
 * subscription lane's own map, stated as a fixture. Since issue #172 that
 * mapping belongs to the execution lane (and since #226 there is no pre-lane
 * default map at all), so the resolver stops at the tier and this helper does
 * the last step — keeping every precedence assertion below readable as "which
 * model would this pass run", which is the question they were written to
 * answer. The lane-specific mapping is tested in
 * `src/lib/lanes/__tests__/resolve.test.ts`.
 */
const LANE_MODELS: Record<"heavy" | "standard" | "light", string> = {
  heavy: "opus",
  standard: "sonnet",
  light: "haiku",
};

function modelOn(
  kind: Parameters<typeof resolveAgentModelChoice>[0],
  config: AppConfig,
  ticketModel: string | null,
  overrides: SettingsOverrides
): string | null {
  const { tier, pinnedModel } = resolveAgentModelChoice(
    kind,
    config,
    ticketModel,
    overrides
  );
  return tier !== null ? LANE_MODELS[tier] : pinnedModel;
}

/** A config carrying only the fields the model tier reads. */
function cfg(models: {
  agentModel: string | null;
  agentModelReview?: string | null;
  agentModelTriage?: string | null;
}): AppConfig {
  return {
    agentModel: models.agentModel,
    agentModelReview: models.agentModelReview ?? null,
    agentModelTriage: models.agentModelTriage ?? null,
  } as AppConfig;
}

/** A config carrying only the fields resolveAgentEffort reads. */
function effortCfg(efforts: {
  agentEffort: string | null;
  agentEffortReview?: string | null;
  agentEffortTriage?: string | null;
}): AppConfig {
  return {
    agentEffort: efforts.agentEffort,
    agentEffortReview: efforts.agentEffortReview ?? null,
    agentEffortTriage: efforts.agentEffortTriage ?? null,
  } as AppConfig;
}

describe("the model tier (issue #74)", () => {
  it("returns null for every kind when nothing is configured (the harness's default)", () => {
    const c = cfg({ agentModel: null });
    for (const kind of [
      "interactive",
      "implement",
      "review",
      "triage",
      "repair",
    ] as AgentPassKind[]) {
      expect(modelOn(kind, c, null, NO_OVERRIDES)).toBeNull();
    }
  });

  it("uses AGENT_MODEL as the base for implement, repair and interactive", () => {
    const c = cfg({ agentModel: "base-model" });
    expect(modelOn("implement", c, null, NO_OVERRIDES)).toBe("base-model");
    expect(modelOn("repair", c, null, NO_OVERRIDES)).toBe("base-model");
    expect(modelOn("interactive", c, null, NO_OVERRIDES)).toBe("base-model");
  });

  it("falls back review and triage to the base when they have no override", () => {
    const c = cfg({ agentModel: "base-model" });
    expect(modelOn("review", c, null, NO_OVERRIDES)).toBe("base-model");
    expect(modelOn("triage", c, null, NO_OVERRIDES)).toBe("base-model");
  });

  it("prefers the cheaper-tier overrides for review and triage", () => {
    const c = cfg({
      agentModel: "base-model",
      agentModelReview: "review-model",
      agentModelTriage: "triage-model",
    });
    expect(modelOn("review", c, null, NO_OVERRIDES)).toBe("review-model");
    expect(modelOn("triage", c, null, NO_OVERRIDES)).toBe("triage-model");
    // Overrides never leak onto the base kinds.
    expect(modelOn("implement", c, null, NO_OVERRIDES)).toBe("base-model");
  });

  it("lets an override apply even when the base is unset", () => {
    const c = cfg({ agentModel: null, agentModelReview: "review-model" });
    expect(modelOn("review", c, null, NO_OVERRIDES)).toBe("review-model");
    expect(modelOn("triage", c, null, NO_OVERRIDES)).toBeNull();
    expect(modelOn("implement", c, null, NO_OVERRIDES)).toBeNull();
  });
});

describe("resolveAgentEffort (issue #81)", () => {
  it("returns null for every kind when nothing is configured (the harness's default)", () => {
    const c = effortCfg({ agentEffort: null });
    for (const kind of [
      "interactive",
      "implement",
      "review",
      "triage",
      "repair",
    ] as AgentPassKind[]) {
      expect(resolveAgentEffort(kind, c)).toBeNull();
    }
  });

  it("uses AGENT_EFFORT as the base for implement, repair and interactive", () => {
    const c = effortCfg({ agentEffort: "high" });
    expect(resolveAgentEffort("implement", c)).toBe("high");
    expect(resolveAgentEffort("repair", c)).toBe("high");
    expect(resolveAgentEffort("interactive", c)).toBe("high");
  });

  it("falls back review and triage to the base when they have no override", () => {
    const c = effortCfg({ agentEffort: "high" });
    expect(resolveAgentEffort("review", c)).toBe("high");
    expect(resolveAgentEffort("triage", c)).toBe("high");
  });

  it("prefers the lower-level overrides for review and triage", () => {
    const c = effortCfg({
      agentEffort: "high",
      agentEffortReview: "medium",
      agentEffortTriage: "low",
    });
    expect(resolveAgentEffort("review", c)).toBe("medium");
    expect(resolveAgentEffort("triage", c)).toBe("low");
    // Overrides never leak onto the base kinds.
    expect(resolveAgentEffort("implement", c)).toBe("high");
  });

  it("lets an override apply even when the base is unset", () => {
    const c = effortCfg({ agentEffort: null, agentEffortReview: "medium" });
    expect(resolveAgentEffort("review", c)).toBe("medium");
    expect(resolveAgentEffort("triage", c)).toBeNull();
    expect(resolveAgentEffort("implement", c)).toBeNull();
  });

  it("lets a ticket effort override the base for work kinds only", () => {
    const c = effortCfg({ agentEffort: "medium", agentEffortReview: "low" });
    // The ticket chooses the effort its *work* runs at...
    expect(resolveAgentEffort("implement", c, "max")).toBe("max");
    expect(resolveAgentEffort("repair", c, "max")).toBe("max");
    expect(resolveAgentEffort("interactive", c, "max")).toBe("max");
    // ...not the reviewer's or triage's, which keep their own resolution.
    expect(resolveAgentEffort("review", c, "max")).toBe("low");
    expect(resolveAgentEffort("triage", c, "max")).toBe("medium");
  });

  it("falls back to the base when no ticket effort is given", () => {
    const c = effortCfg({ agentEffort: "high" });
    expect(resolveAgentEffort("implement", c, null)).toBe("high");
  });
});

/**
 * Effort is validated against the **fleet's** vocabulary (issue #226): the
 * five levels are the ticket directive's and the settings' words, and what a
 * level means on a given harness is that adapter's `mapEffort` (issue #214).
 * The warning therefore names the vocabulary and no harness's flag.
 */
describe("getConfig effort env validation (issue #81)", () => {
  const saved = {
    AGENT_EFFORT: process.env.AGENT_EFFORT,
    AGENT_EFFORT_REVIEW: process.env.AGENT_EFFORT_REVIEW,
    AGENT_EFFORT_TRIAGE: process.env.AGENT_EFFORT_TRIAGE,
  };

  beforeEach(() => {
    delete process.env.AGENT_EFFORT;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetConfig();
    vi.restoreAllMocks();
  });

  it("keeps a recognised env effort level", () => {
    process.env.AGENT_EFFORT = "high";
    resetConfig();
    expect(getConfig().agentEffort).toBe("high");
  });

  it("drops an unrecognised env effort level to null and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.AGENT_EFFORT = "hihg"; // fleet-wide typo
    resetConfig();
    expect(getConfig().agentEffort).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("effort"));
  });

  it("names the fleet's effort vocabulary in the warning, and no harness's flag", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.AGENT_EFFORT = "hihg";
    resetConfig();
    getConfig();
    const messages = warn.mock.calls.map((call) => String(call[0]));
    const message = messages.find((text) => text.includes("effort"));
    expect(message).toContain(ALLOWED_TICKET_EFFORTS.join(", "));
    // The level set is the fleet's, not a CLI's: the message must not describe
    // it as a flag or a CLI default, since a second harness maps the same
    // words onto a different dial.
    expect(message).not.toMatch(/\bCLI\b/);
    expect(message).not.toContain("--effort");
  });

  it("treats an unset env effort as null without an effort warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetConfig();
    expect(getConfig().agentEffort).toBeNull();
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("effort"));
  });
});

describe("AGENT_LANE (issue #172)", () => {
  const saved = {
    AGENT_LANE: process.env.AGENT_LANE,
  };

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetConfig();
  });

  it("is null when unset, so the lane file's preference order decides", () => {
    delete process.env.AGENT_LANE;
    resetConfig();
    expect(getConfig().agentLane).toBeNull();
  });

  it("normalises casing and whitespace, so the env and the UI agree", () => {
    // The UI path lowercases before storing. Without the same treatment here,
    // AGENT_LANE=OpenRouter would read as a dangling choice rather than a lane.
    process.env.AGENT_LANE = "  OpenRouter ";
    resetConfig();
    expect(getConfig().agentLane).toBe("openrouter");
  });

  it("treats a blank value as unset rather than as a lane named \"\"", () => {
    process.env.AGENT_LANE = "   ";
    resetConfig();
    expect(getConfig().agentLane).toBeNull();
  });
});

/**
 * The app config holds no model-provider credential (issue #226). Which
 * variables a pass needs is the lane file's declaration, read by name at pass
 * start; whether the deployment holds them is the boot-time lane-availability
 * report's business (`src/lib/lanes/availability.ts`), lane by lane. So a
 * config read with no credential variable set at all warns about nothing —
 * the warning that used to name one vendor's two variables is gone, and its
 * fields with it.
 */
describe("no vendor credential in the app config (issue #226)", () => {
  const CREDENTIALS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"];
  const saved = Object.fromEntries(CREDENTIALS.map((k) => [k, process.env[k]]));

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetConfig();
    vi.restoreAllMocks();
  });

  it("carries no credential field and warns about none", () => {
    for (const k of CREDENTIALS) delete process.env[k];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetConfig();
    const config = getConfig();
    expect(warn).not.toHaveBeenCalled();
    // The two retired fields are gone, not merely null: a reader that wanted a
    // model-provider credential has to ask the lane resolver for it.
    expect(config).not.toHaveProperty("anthropicApiKey");
    expect(config).not.toHaveProperty("claudeCodeOauthToken");
  });
});

describe("the model tier ticket model override (issue #80)", () => {
  it("lets a ticket model override the base for the work-carrying kinds", () => {
    const c = cfg({ agentModel: "base-model" });
    // `opus` is the legacy alias for the heavy tier, which reaches the CLI
    // as `opus` — so a ticket written before tiers existed is unchanged.
    expect(modelOn("implement", c, "opus", NO_OVERRIDES)).toBe("opus");
    expect(modelOn("repair", c, "opus", NO_OVERRIDES)).toBe("opus");
    expect(modelOn("interactive", c, "heavy", NO_OVERRIDES)).toBe(
      "opus"
    );
  });

  it("overrides even when no base model is configured", () => {
    const c = cfg({ agentModel: null });
    expect(modelOn("implement", c, "sonnet", NO_OVERRIDES)).toBe("sonnet");
  });

  it("never lets a ticket model touch the reviewer's or triage's tier", () => {
    const c = cfg({
      agentModel: "base-model",
      agentModelReview: "review-model",
      agentModelTriage: "triage-model",
    });
    expect(modelOn("review", c, "opus", NO_OVERRIDES)).toBe("review-model");
    expect(modelOn("triage", c, "opus", NO_OVERRIDES)).toBe("triage-model");
  });

  it("falls back to the base when the override is null", () => {
    const c = cfg({ agentModel: "base-model" });
    expect(modelOn("implement", c, null, NO_OVERRIDES)).toBe("base-model");
    expect(modelOn("implement", c, null, NO_OVERRIDES)).toBe(
      "base-model"
    );
  });
});

/**
 * The three layers of "which model does this pass run on", in order (issue
 * #166): a ticket's directive, then the UI override, then the environment.
 */
describe("the model tier with UI overrides (issue #166)", () => {
  const c = cfg({
    agentModel: "claude-opus-4-8",
    agentModelReview: "review-model",
    agentModelTriage: "triage-model",
  });

  it("runs each pass kind on the tier its own field is set to", () => {
    expect(
      modelOn("implement", c, null, { modelTierImplement: "light" })
    ).toBe("haiku");
    expect(
      modelOn("review", c, null, { modelTierReview: "standard" })
    ).toBe("sonnet");
    expect(
      modelOn("triage", c, null, { modelTierTriage: "light" })
    ).toBe("haiku");
    expect(
      modelOn("interactive", c, null, {
        modelTierInteractive: "heavy",
      })
    ).toBe("opus");
  });

  it("falls an unset field through to the environment default", () => {
    // One field set, the rest untouched — a fresh deployment's behaviour is
    // what the others keep.
    const overrides = { modelTierTriage: "light" as const };
    expect(modelOn("triage", c, null, overrides)).toBe("haiku");
    expect(modelOn("review", c, null, overrides)).toBe("review-model");
    expect(modelOn("implement", c, null, overrides)).toBe(
      "claude-opus-4-8"
    );
  });

  it("lets a ticket's model directive outrank the UI override", () => {
    // The directive is the ticket saying this *work* is hard; the setting is
    // the fleet's standing default.
    expect(
      modelOn("implement", c, "heavy", { modelTierImplement: "light" })
    ).toBe("opus");
    expect(
      modelOn("repair", c, "opus", { modelTierImplement: "light" })
    ).toBe("opus");
  });

  it("still keeps a ticket directive off the reviewer's and triage's tiers", () => {
    expect(
      modelOn("review", c, "heavy", { modelTierReview: "light" })
    ).toBe("haiku");
    expect(
      modelOn("triage", c, "heavy", { modelTierTriage: "light" })
    ).toBe("haiku");
  });

  it("ignores a recorded raw model id in the directive slot", () => {
    // A run row records the model the pass actually ran; fed back on a
    // follow-up turn it names no tier, so the configured default decides.
    expect(
      modelOn("implement", c, "claude-opus-4-8", {
        modelTierImplement: "light",
      })
    ).toBe("haiku");
  });
});

/**
 * Review derives its tier from the run's implement tier (issue #201): one rung
 * above it, capped at the top of the vocabulary, held under the review's own
 * fleet setting only when an operator has explicitly set one. It is the only
 * kind that derives — repair runs at the run's own tier (issue #211, below).
 * `ticketModel` here is what the turn manager passes on every later pass of a
 * run — `runs.model`, the tier the implement pass actually ran at.
 */
describe("the derived review tier (issue #201)", () => {
  /** Nothing set anywhere for review, so the derivation runs free; the base
   * is set so an implement pass with no directive still resolves. */
  const free = cfg({ agentModel: null });

  it("resolves a review pass one rung above the run's implement tier", () => {
    expect(modelOn("review", free, "light", NO_OVERRIDES)).toBe("sonnet");
    expect(modelOn("review", free, "standard", NO_OVERRIDES)).toBe("opus");
  });

  it("caps the derivation at the top of the vocabulary rather than overflowing", () => {
    expect(modelOn("review", free, "heavy", NO_OVERRIDES)).toBe("opus");
    expect(modelOn("review", free, "opus", NO_OVERRIDES)).toBe("opus");
  });

  it("holds the derivation under an explicitly set per-kind tier — a UI override", () => {
    // The operator set the review tier low as a cost measure; a heavy
    // ticket's review is capped there. That is the accepted consequence, and
    // the same treatment an explicit lane choice gets.
    expect(
      modelOn("review", free, "heavy", { modelTierReview: "light" })
    ).toBe("haiku");
    expect(
      modelOn("review", free, "standard", { modelTierReview: "standard" })
    ).toBe("sonnet");
  });

  it("holds the derivation under an explicitly set per-kind tier — the kind's own variable", () => {
    const c = cfg({ agentModel: null, agentModelReview: "standard" });
    expect(modelOn("review", c, "standard", NO_OVERRIDES)).toBe("sonnet");
    expect(modelOn("review", c, "heavy", NO_OVERRIDES)).toBe("sonnet");
  });

  it("does not read the base AGENT_MODEL as the review's ceiling", () => {
    // `AGENT_MODEL` is the implement kind's own variable, not the *review*
    // kind's setting: it is what a review with
    // nothing to derive from falls back to. Read as the review's ceiling it
    // would cap every review at the implement tier in the commonest
    // configuration — the "equal" design the ticket rejected — and a heavy
    // ticket's review below its implement pass with nobody having chosen so.
    const base = cfg({ agentModel: "standard" });
    expect(modelOn("review", base, "standard", NO_OVERRIDES)).toBe("opus");
    expect(modelOn("review", base, "light", NO_OVERRIDES)).toBe("sonnet");
    // With no run tier the base is still what the review runs, as before.
    expect(modelOn("review", base, null, NO_OVERRIDES)).toBe("sonnet");
  });

  it("never lets a ceiling raise the derivation — it is a cap, not a floor", () => {
    expect(
      modelOn("review", free, "light", { modelTierReview: "heavy" })
    ).toBe("sonnet");
    const c = cfg({ agentModel: null, agentModelReview: "heavy" });
    expect(modelOn("review", c, "light", NO_OVERRIDES)).toBe("sonnet");
  });

  it("lets an unset per-kind tier run the derivation free", () => {
    // Only triage and the base are set: the review field is untouched, so a
    // light ticket's review runs one rung up rather than at anything the
    // operator chose.
    const c = cfg({ agentModel: "light", agentModelTriage: "light" });
    expect(
      modelOn("review", c, "light", { modelTierTriage: "light" })
    ).toBe("sonnet");
    expect(modelOn("review", c, "standard", NO_OVERRIDES)).toBe("opus");
  });

  it("derives nothing for a run with no resolved implement tier, resolving exactly as before", () => {
    const c = cfg({ agentModel: "claude-opus-4-8", agentModelReview: "light" });
    // No run tier at all — the fleet setting decides, as it did before.
    expect(modelOn("review", c, null, NO_OVERRIDES)).toBe("haiku");
    // A pinned raw model id recorded on the run row names no tier to step
    // from, so it is treated exactly as none.
    expect(modelOn("review", c, "claude-opus-4-8", NO_OVERRIDES)).toBe("haiku");
    expect(
      modelOn("review", c, "claude-opus-4-8", { modelTierReview: "standard" })
    ).toBe("sonnet");
    expect(modelOn("review", free, null, NO_OVERRIDES)).toBeNull();
  });

  it("runs a review as pinned when its own field pins a raw model id, whatever the run's tier", () => {
    // `AGENT_MODEL_REVIEW=claude-opus-4-8` names an identifier, not a tier, so
    // there is nothing to bound a tier with — and the reviewer's field is the
    // operator's own, which a ticket may not touch: the pin is the answer, as
    // it always was.
    const c = cfg({ agentModel: null, agentModelReview: "claude-opus-4-8" });
    expect(modelOn("review", c, "light", NO_OVERRIDES)).toBe("claude-opus-4-8");
    expect(modelOn("review", c, "heavy", NO_OVERRIDES)).toBe("claude-opus-4-8");
  });

  it("derives a review past a pin arriving through the base, which is not the reviewer's own", () => {
    // `AGENT_MODEL=claude-opus-4-8` is the implement kind's, standing in for
    // an unset AGENT_MODEL_REVIEW, not the reviewer's own answer — so a review
    // with a tier to derive from steps up from it, and one without runs the
    // pin as the fall-back it always was.
    const c = cfg({ agentModel: "claude-opus-4-8" });
    expect(modelOn("review", c, "light", NO_OVERRIDES)).toBe("sonnet");
    expect(modelOn("review", c, null, NO_OVERRIDES)).toBe("claude-opus-4-8");
  });

  it("derives nothing for triage and interactive, which keep their chosen settings", () => {
    const c = cfg({ agentModel: "standard", agentModelTriage: "light" });
    // Triage never reads the run's tier at all.
    expect(modelOn("triage", c, "heavy", NO_OVERRIDES)).toBe("haiku");
    expect(modelOn("triage", c, "light", { modelTierTriage: "standard" })).toBe(
      "sonnet"
    );
    // Interactive still takes the run's tier as its own — a human is present
    // to ask for something else — and otherwise its field.
    expect(modelOn("interactive", c, "light", NO_OVERRIDES)).toBe("haiku");
    expect(
      modelOn("interactive", c, null, { modelTierInteractive: "heavy" })
    ).toBe("opus");
  });

  it("still never lets a ticket set its own review or triage tier", () => {
    // A ticket declaring `light` does not buy itself a light gate: the only
    // way its tier reaches the review is one rung up, never level.
    expect(modelOn("review", free, "light", NO_OVERRIDES)).not.toBe("haiku");
    // And a ticket declaring `heavy` cannot lift a review the operator capped.
    expect(
      modelOn("review", free, "heavy", { modelTierReview: "light" })
    ).toBe("haiku");
    expect(modelOn("triage", cfg({ agentModel: "light" }), "heavy", NO_OVERRIDES)).toBe(
      "haiku"
    );
  });

  it("leaves the implement pass exactly as it was", () => {
    const c = cfg({ agentModel: "standard" });
    expect(modelOn("implement", c, "light", NO_OVERRIDES)).toBe("haiku");
    expect(modelOn("implement", c, null, NO_OVERRIDES)).toBe("sonnet");
    expect(
      modelOn("implement", c, null, { modelTierImplement: "heavy" })
    ).toBe("opus");
  });
});

/**
 * A repair pass runs at the tier the run's implement pass ran at (issue #211)
 * — no step, no derivation. Both passes queued under the kind (integration
 * repair, #54; CI repair, #130) are triggered by the default branch moving
 * under a parked PR, not by the work being judged wrong, so the one-rung
 * step-up #201 gave it was for a failure that is not what a repair is. It
 * resolves exactly as an implement pass does: the run's tier wins; with none,
 * the implement setting answers.
 */
describe("a repair pass runs at the run's own tier (issue #211)", () => {
  const free = cfg({ agentModel: null });

  it("resolves a repair pass to the tier the run's implement pass ran at, with no step", () => {
    expect(modelOn("repair", free, "light", NO_OVERRIDES)).toBe("haiku");
    expect(modelOn("repair", free, "standard", NO_OVERRIDES)).toBe("sonnet");
    expect(modelOn("repair", free, "heavy", NO_OVERRIDES)).toBe("opus");
    // A legacy alias recorded on the run row names the same tier.
    expect(modelOn("repair", free, "opus", NO_OVERRIDES)).toBe("opus");
  });

  it("lets the run's tier outrank the implement setting for a repair, as it does for the implement pass", () => {
    // The implement field is a default the ticket's directive outranked for
    // the implement pass (issue #80); the run's tier *is* that directive, so
    // the repair continues the work at it whichever way the setting points.
    expect(
      modelOn("repair", free, "heavy", { modelTierImplement: "light" })
    ).toBe("opus");
    expect(
      modelOn("repair", free, "light", { modelTierImplement: "heavy" })
    ).toBe("haiku");
    expect(modelOn("repair", cfg({ agentModel: "heavy" }), "light", NO_OVERRIDES)).toBe(
      "haiku"
    );
    // A raw model id pinned in AGENT_MODEL is what the implement pass would
    // have run had the ticket declared nothing; the run's tier outranks it
    // for the repair exactly as it did for the work.
    expect(
      modelOn("repair", cfg({ agentModel: "claude-opus-4-8" }), "light", NO_OVERRIDES)
    ).toBe("haiku");
  });

  it("resolves a repair on a run with no recorded tier through the implement setting, exactly as an implement pass with no ticket tier", () => {
    expect(modelOn("repair", cfg({ agentModel: "standard" }), null, NO_OVERRIDES)).toBe(
      "sonnet"
    );
    expect(
      modelOn("repair", cfg({ agentModel: "standard" }), null, { modelTierImplement: "light" })
    ).toBe("haiku");
    // A raw model id pinned in AGENT_MODEL passes through verbatim.
    expect(
      modelOn("repair", cfg({ agentModel: "claude-opus-4-8" }), null, NO_OVERRIDES)
    ).toBe("claude-opus-4-8");
    // And a raw id recorded on the run row names no tier, so it is treated
    // exactly as none.
    expect(
      modelOn("repair", cfg({ agentModel: "standard" }), "claude-opus-4-8", NO_OVERRIDES)
    ).toBe("sonnet");
    // Nothing set anywhere: no --model, the harness decides.
    expect(modelOn("repair", free, null, NO_OVERRIDES)).toBeNull();
  });

  it("resolves a repair exactly as an implement pass across every tier and setting", () => {
    // The two flavours of repair share the kind, and the kind shares the
    // implement pass's rule wholesale — so the two can never part company on
    // any (run tier, setting) pair, not only the ones spelled out above.
    const configs = [
      free,
      cfg({ agentModel: "light" }),
      cfg({ agentModel: "standard" }),
      cfg({ agentModel: "heavy" }),
      cfg({ agentModel: "claude-opus-4-8" }),
    ];
    const overrideSets: SettingsOverrides[] = [
      NO_OVERRIDES,
      { modelTierImplement: "light" },
      { modelTierImplement: "heavy" },
    ];
    const runTiers = [null, "light", "standard", "heavy", "opus", "claude-opus-4-8"];
    for (const c of configs) {
      for (const overrides of overrideSets) {
        for (const runTier of runTiers) {
          expect(modelOn("repair", c, runTier, overrides)).toBe(
            modelOn("implement", c, runTier, overrides)
          );
        }
      }
    }
  });
});
