import { describe, it, expect } from "vitest";
import { resolveAgentModel, type AppConfig, type AgentPassKind } from "../config";

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
      expect(resolveAgentModel(kind, c)).toBeNull();
    }
  });

  it("uses AGENT_MODEL as the base for implement, repair and interactive", () => {
    const c = cfg({ agentModel: "base-model" });
    expect(resolveAgentModel("implement", c)).toBe("base-model");
    expect(resolveAgentModel("repair", c)).toBe("base-model");
    expect(resolveAgentModel("interactive", c)).toBe("base-model");
  });

  it("falls back review and triage to the base when they have no override", () => {
    const c = cfg({ agentModel: "base-model" });
    expect(resolveAgentModel("review", c)).toBe("base-model");
    expect(resolveAgentModel("triage", c)).toBe("base-model");
  });

  it("prefers the cheaper-tier overrides for review and triage", () => {
    const c = cfg({
      agentModel: "base-model",
      agentModelReview: "review-model",
      agentModelTriage: "triage-model",
    });
    expect(resolveAgentModel("review", c)).toBe("review-model");
    expect(resolveAgentModel("triage", c)).toBe("triage-model");
    // Overrides never leak onto the base kinds.
    expect(resolveAgentModel("implement", c)).toBe("base-model");
  });

  it("lets an override apply even when the base is unset", () => {
    const c = cfg({ agentModel: null, agentModelReview: "review-model" });
    expect(resolveAgentModel("review", c)).toBe("review-model");
    expect(resolveAgentModel("triage", c)).toBeNull();
    expect(resolveAgentModel("implement", c)).toBeNull();
  });
});
