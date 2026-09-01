import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getConfig,
  resetConfig,
  resolveAgentModel,
  resolveAgentEffort,
  type AppConfig,
  type AgentPassKind,
} from "../config";
import type { SettingsOverrides } from "../settings-resolver";

/** No UI overrides stored — the state a fresh install is in, where every
 * field falls through to the environment. */
const NO_OVERRIDES: SettingsOverrides = {};

/** A config carrying only the fields resolveAgentModel reads. */
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

describe("resolveAgentModel (issue #74)", () => {
  it("returns null for every kind when nothing is configured (CLI default)", () => {
    const c = cfg({ agentModel: null });
    for (const kind of [
      "interactive",
      "implement",
      "review",
      "triage",
      "repair",
    ] as AgentPassKind[]) {
      expect(resolveAgentModel(kind, c, null, NO_OVERRIDES)).toBeNull();
    }
  });

  it("uses AGENT_MODEL as the base for implement, repair and interactive", () => {
    const c = cfg({ agentModel: "base-model" });
    expect(resolveAgentModel("implement", c, null, NO_OVERRIDES)).toBe("base-model");
    expect(resolveAgentModel("repair", c, null, NO_OVERRIDES)).toBe("base-model");
    expect(resolveAgentModel("interactive", c, null, NO_OVERRIDES)).toBe("base-model");
  });

  it("falls back review and triage to the base when they have no override", () => {
    const c = cfg({ agentModel: "base-model" });
    expect(resolveAgentModel("review", c, null, NO_OVERRIDES)).toBe("base-model");
    expect(resolveAgentModel("triage", c, null, NO_OVERRIDES)).toBe("base-model");
  });

  it("prefers the cheaper-tier overrides for review and triage", () => {
    const c = cfg({
      agentModel: "base-model",
      agentModelReview: "review-model",
      agentModelTriage: "triage-model",
    });
    expect(resolveAgentModel("review", c, null, NO_OVERRIDES)).toBe("review-model");
    expect(resolveAgentModel("triage", c, null, NO_OVERRIDES)).toBe("triage-model");
    // Overrides never leak onto the base kinds.
    expect(resolveAgentModel("implement", c, null, NO_OVERRIDES)).toBe("base-model");
  });

  it("lets an override apply even when the base is unset", () => {
    const c = cfg({ agentModel: null, agentModelReview: "review-model" });
    expect(resolveAgentModel("review", c, null, NO_OVERRIDES)).toBe("review-model");
    expect(resolveAgentModel("triage", c, null, NO_OVERRIDES)).toBeNull();
    expect(resolveAgentModel("implement", c, null, NO_OVERRIDES)).toBeNull();
  });
});

describe("resolveAgentEffort (issue #81)", () => {
  it("returns null for every kind when nothing is configured (CLI default)", () => {
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

describe("getConfig effort env validation (issue #81)", () => {
  const saved = {
    AGENT_EFFORT: process.env.AGENT_EFFORT,
    AGENT_EFFORT_REVIEW: process.env.AGENT_EFFORT_REVIEW,
    AGENT_EFFORT_TRIAGE: process.env.AGENT_EFFORT_TRIAGE,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };

  beforeEach(() => {
    // Suppress the unrelated "no Claude auth" warning so the assertions below
    // observe only the effort-validation warning.
    process.env.ANTHROPIC_API_KEY = "test-key";
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

  it("treats an unset env effort as null without an effort warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetConfig();
    expect(getConfig().agentEffort).toBeNull();
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("effort"));
  });
});

describe("resolveAgentModel ticket model override (issue #80)", () => {
  it("lets a ticket model override the base for the work-carrying kinds", () => {
    const c = cfg({ agentModel: "base-model" });
    // `opus` is the legacy alias for the heavy tier, which reaches the CLI
    // as `opus` — so a ticket written before tiers existed is unchanged.
    expect(resolveAgentModel("implement", c, "opus", NO_OVERRIDES)).toBe("opus");
    expect(resolveAgentModel("repair", c, "opus", NO_OVERRIDES)).toBe("opus");
    expect(resolveAgentModel("interactive", c, "heavy", NO_OVERRIDES)).toBe(
      "opus"
    );
  });

  it("overrides even when no base model is configured", () => {
    const c = cfg({ agentModel: null });
    expect(resolveAgentModel("implement", c, "sonnet", NO_OVERRIDES)).toBe("sonnet");
  });

  it("never lets a ticket model touch the reviewer's or triage's tier", () => {
    const c = cfg({
      agentModel: "base-model",
      agentModelReview: "review-model",
      agentModelTriage: "triage-model",
    });
    expect(resolveAgentModel("review", c, "opus", NO_OVERRIDES)).toBe("review-model");
    expect(resolveAgentModel("triage", c, "opus", NO_OVERRIDES)).toBe("triage-model");
  });

  it("falls back to the base when the override is null", () => {
    const c = cfg({ agentModel: "base-model" });
    expect(resolveAgentModel("implement", c, null, NO_OVERRIDES)).toBe("base-model");
    expect(resolveAgentModel("implement", c, null, NO_OVERRIDES)).toBe(
      "base-model"
    );
  });
});

/**
 * The three layers of "which model does this pass run on", in order (issue
 * #166): a ticket's directive, then the UI override, then the environment.
 */
describe("resolveAgentModel with UI overrides (issue #166)", () => {
  const c = cfg({
    agentModel: "claude-opus-4-8",
    agentModelReview: "review-model",
    agentModelTriage: "triage-model",
  });

  it("runs each pass kind on the tier its own field is set to", () => {
    expect(
      resolveAgentModel("implement", c, null, { modelTierImplement: "light" })
    ).toBe("haiku");
    expect(
      resolveAgentModel("review", c, null, { modelTierReview: "standard" })
    ).toBe("sonnet");
    expect(
      resolveAgentModel("triage", c, null, { modelTierTriage: "light" })
    ).toBe("haiku");
    expect(
      resolveAgentModel("interactive", c, null, {
        modelTierInteractive: "heavy",
      })
    ).toBe("opus");
  });

  it("falls an unset field through to the environment default", () => {
    // One field set, the rest untouched — a fresh deployment's behaviour is
    // what the others keep.
    const overrides = { modelTierTriage: "light" as const };
    expect(resolveAgentModel("triage", c, null, overrides)).toBe("haiku");
    expect(resolveAgentModel("review", c, null, overrides)).toBe("review-model");
    expect(resolveAgentModel("implement", c, null, overrides)).toBe(
      "claude-opus-4-8"
    );
  });

  it("lets a ticket's model directive outrank the UI override", () => {
    // The directive is the ticket saying this *work* is hard; the setting is
    // the fleet's standing default.
    expect(
      resolveAgentModel("implement", c, "heavy", { modelTierImplement: "light" })
    ).toBe("opus");
    expect(
      resolveAgentModel("repair", c, "opus", { modelTierImplement: "light" })
    ).toBe("opus");
  });

  it("still keeps a ticket directive off the reviewer's and triage's tiers", () => {
    expect(
      resolveAgentModel("review", c, "heavy", { modelTierReview: "light" })
    ).toBe("haiku");
    expect(
      resolveAgentModel("triage", c, "heavy", { modelTierTriage: "light" })
    ).toBe("haiku");
  });

  it("ignores a recorded raw model id in the directive slot", () => {
    // A run row records the model the pass actually ran; fed back on a
    // follow-up turn it names no tier, so the configured default decides.
    expect(
      resolveAgentModel("implement", c, "claude-opus-4-8", {
        modelTierImplement: "light",
      })
    ).toBe("haiku");
  });
});
