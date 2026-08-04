import { describe, it, expect } from "vitest";
import {
  resolveAgentModel,
  resolveAgentEffort,
  type AppConfig,
  type AgentPassKind,
} from "../config";

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
