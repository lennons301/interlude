import { describe, expect, it } from "vitest";
import type { AppConfig } from "../config";
import { DEFAULT_QUOTA_PICKUP_THRESHOLD_PERCENT } from "../quota/quota-gate";
import {
  MODEL_TIERS,
  TIER_MODEL_IDS,
  normalizeModelTier,
} from "../model-tiers";
import {
  FIXED_CEILINGS,
  MODEL_TIER_FIELD_ORDER,
  SETTINGS_FIELDS,
  SETTABLE_KEYS,
  applySettingsPatch,
  describeModelTierSettings,
  parseSettingsPatch,
  resolveModelTier,
  resolveQuotaThreshold,
  sanitizeOverrides,
  type SettingsOverrides,
} from "../settings-resolver";

/**
 * The settings resolver (issue #166) — the layer that lets a UI override sit
 * on top of env config. Pure by construction, so the five rules that make it
 * trustworthy are table-tested here rather than inferred from a screen:
 * fall-through, override, rejection, ceiling, provenance.
 */

/** A config carrying only the model fields the resolver reads. */
function cfg(models: {
  agentModel?: string | null;
  agentModelReview?: string | null;
  agentModelTriage?: string | null;
  agentLane?: string | null;
  quotaPickupThresholdPercent?: string | null;
} = {}): AppConfig {
  return {
    agentModel: models.agentModel ?? null,
    agentModelReview: models.agentModelReview ?? null,
    agentModelTriage: models.agentModelTriage ?? null,
    agentLane: models.agentLane ?? null,
    quotaPickupThresholdPercent: models.quotaPickupThresholdPercent ?? null,
  } as AppConfig;
}

const NONE: SettingsOverrides = {};

describe("model tier vocabulary", () => {
  it("accepts the tiers and the legacy vendor aliases, case-insensitively", () => {
    expect(normalizeModelTier("heavy")).toBe("heavy");
    expect(normalizeModelTier(" Standard ")).toBe("standard");
    expect(normalizeModelTier("opus")).toBe("heavy");
    expect(normalizeModelTier("SONNET")).toBe("standard");
    expect(normalizeModelTier("haiku")).toBe("light");
  });

  it("names no tier for a raw model id or an unknown word", () => {
    // A pinned model id stays legal env config — it just isn't a tier.
    expect(normalizeModelTier("claude-opus-4-8")).toBeNull();
    expect(normalizeModelTier("gpt-4")).toBeNull();
    expect(normalizeModelTier("")).toBeNull();
    expect(normalizeModelTier(null)).toBeNull();
  });

  it("maps every tier to a model id the CLI accepts", () => {
    expect(MODEL_TIERS.map((tier) => TIER_MODEL_IDS[tier])).toEqual([
      "opus",
      "sonnet",
      "haiku",
    ]);
  });
});

describe("fall-through — an unset override behaves exactly as before", () => {
  it("resolves every pass kind to no model when the environment is unset", () => {
    const c = cfg();
    for (const kind of ["implement", "repair", "review", "triage", "interactive"] as const) {
      const resolved = resolveModelTier(kind, c, NONE);
      expect(resolved.model).toBeNull();
      expect(resolved.tier).toBeNull();
      expect(resolved.source).toBe("environment");
    }
  });

  it("maps a tier named in the environment through the same map an override uses", () => {
    // `AGENT_MODEL=heavy` must reach the CLI as a model it accepts, not as the
    // word "heavy" — the environment speaks the same vocabulary as the screen.
    expect(resolveModelTier("implement", cfg({ agentModel: "heavy" }), NONE)).toMatchObject(
      { tier: "heavy", model: "opus", source: "environment" }
    );
    // A legacy alias in the environment is unchanged by that mapping.
    expect(resolveModelTier("implement", cfg({ agentModel: "sonnet" }), NONE)).toMatchObject(
      { tier: "standard", model: "sonnet" }
    );
  });

  it("passes a raw environment model id through verbatim, tier or not", () => {
    const c = cfg({ agentModel: "claude-opus-4-8" });
    const resolved = resolveModelTier("implement", c, NONE);
    expect(resolved.model).toBe("claude-opus-4-8");
    // It names no tier, and saying so is not the same as rejecting it.
    expect(resolved.tier).toBeNull();
    expect(resolved.source).toBe("environment");
  });

  it("names the variable that actually supplied the value", () => {
    // Review and triage read their own variable and fall back to the base. A
    // provenance line naming a variable the operator would find empty is worse
    // than none, so the row reports whichever one answered.
    const own = cfg({ agentModel: "base-model", agentModelReview: "review-model" });
    expect(resolveModelTier("review", own, NONE)).toMatchObject({
      envVar: "AGENT_MODEL_REVIEW",
      envValue: "review-model",
    });

    const fellBack = cfg({ agentModel: "base-model" });
    expect(resolveModelTier("review", fellBack, NONE)).toMatchObject({
      envVar: "AGENT_MODEL",
      envValue: "base-model",
    });

    // With neither set there is nothing to point at but the row's own
    // variable — the place to set one.
    expect(resolveModelTier("triage", cfg(), NONE)).toMatchObject({
      envVar: "AGENT_MODEL_TRIAGE",
      envValue: null,
    });
  });

  it("keeps each kind's own environment fall-through", () => {
    const c = cfg({
      agentModel: "base-model",
      agentModelReview: "review-model",
      agentModelTriage: "triage-model",
    });
    expect(resolveModelTier("review", c, NONE).model).toBe("review-model");
    expect(resolveModelTier("triage", c, NONE).model).toBe("triage-model");
    expect(resolveModelTier("implement", c, NONE).model).toBe("base-model");
    expect(resolveModelTier("interactive", c, NONE).model).toBe("base-model");
    // Repair is implement-shaped and deliberately shares its field.
    expect(resolveModelTier("repair", c, NONE).key).toBe("modelTierImplement");
  });
});

describe("override — a set field wins, and only for itself", () => {
  it("runs the pass on the overridden tier's model", () => {
    const c = cfg({ agentModel: "claude-opus-4-8" });
    const resolved = resolveModelTier("implement", c, {
      modelTierImplement: "light",
    });
    expect(resolved).toMatchObject({
      tier: "light",
      model: "haiku",
      source: "override",
      override: "light",
      envValue: "claude-opus-4-8",
    });
  });

  it("never spreads one kind's override onto another", () => {
    const c = cfg({ agentModel: "base-model" });
    const overrides: SettingsOverrides = { modelTierTriage: "light" };
    expect(resolveModelTier("triage", c, overrides).model).toBe("haiku");
    // Review and implement still read their own environment default.
    expect(resolveModelTier("review", c, overrides).model).toBe("base-model");
    expect(resolveModelTier("implement", c, overrides).model).toBe("base-model");
  });

  it("applies to repair through the implement field", () => {
    const c = cfg({ agentModel: "base-model" });
    expect(
      resolveModelTier("repair", c, { modelTierImplement: "standard" }).model
    ).toBe("sonnet");
  });
});

describe("provenance — every field says where its value came from", () => {
  it("reports the environment and names the variable when nothing is set", () => {
    const fields = describeModelTierSettings(cfg({ agentModel: "sonnet" }), NONE);
    const implement = fields.find((f) => f.key === "modelTierImplement")!;
    expect(implement).toMatchObject({
      source: "environment",
      override: null,
      envVar: "AGENT_MODEL",
      envValue: "sonnet",
      tier: "standard",
      model: "sonnet",
    });
  });

  it("reports the override, and still names what clearing it falls back to", () => {
    const fields = describeModelTierSettings(cfg({ agentModel: "sonnet" }), {
      modelTierImplement: "heavy",
    });
    expect(fields.find((f) => f.key === "modelTierImplement")).toMatchObject({
      source: "override",
      override: "heavy",
      model: "opus",
      envValue: "sonnet",
    });
  });

  it("describes every model-tier field, in display order", () => {
    expect(describeModelTierSettings(cfg(), NONE).map((f) => f.key)).toEqual([
      ...MODEL_TIER_FIELD_ORDER,
    ]);
    // Every settable field is placed somewhere, and nothing is placed twice —
    // a length check alone would pass a swapped-out key. The lane field has
    // its own panel (it needs the lane catalog to render), so it is in the
    // settable set without being in the tier panel's order.
    expect([...SETTABLE_KEYS].sort()).toEqual(
      Object.keys(SETTINGS_FIELDS).sort()
    );
    expect(SETTABLE_KEYS).toContain("primaryLane");
    expect(MODEL_TIER_FIELD_ORDER).not.toContain("primaryLane");
  });
});

describe("rejection — a bad value is refused, never silently clamped", () => {
  it("refuses a value outside the vocabulary and says what is accepted", () => {
    const parsed = parseSettingsPatch({ modelTierReview: "turbo" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("turbo");
    expect(parsed.error).toContain("heavy, standard, light");
  });

  it("refuses a raw model id — a tier is the only thing settable here", () => {
    expect(parseSettingsPatch({ modelTierReview: "claude-opus-4-8" }).ok).toBe(
      false
    );
  });

  it("refuses a non-string value rather than coercing it", () => {
    const parsed = parseSettingsPatch({ modelTierReview: 3 });
    expect(parsed).toMatchObject({ ok: false });
  });

  it("refuses a body that is not an object of settings", () => {
    expect(parseSettingsPatch(null).ok).toBe(false);
    expect(parseSettingsPatch("heavy").ok).toBe(false);
    expect(parseSettingsPatch([]).ok).toBe(false);
    expect(parseSettingsPatch({}).ok).toBe(false);
  });

  it("refuses a key that is not settable, listing the ones that are", () => {
    const parsed = parseSettingsPatch({ agentModel: "heavy" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("modelTierImplement");
  });

  it("accepts a tier or an alias, storing the canonical tier", () => {
    expect(parseSettingsPatch({ modelTierReview: "LIGHT" })).toEqual({
      ok: true,
      patch: { modelTierReview: "light" },
    });
    expect(parseSettingsPatch({ modelTierReview: "haiku" })).toEqual({
      ok: true,
      patch: { modelTierReview: "light" },
    });
  });

  it("accepts null as the way to clear an override", () => {
    expect(parseSettingsPatch({ modelTierReview: null })).toEqual({
      ok: true,
      patch: { modelTierReview: null },
    });
  });
});

/**
 * The quota admission threshold (issue #171) — a settable field with three
 * fall-through steps rather than two: a model tier may resolve to "let the
 * harness decide", but a gate needs a number.
 */
describe("the quota pickup threshold", () => {
  it("falls through to its own default with nothing set anywhere", () => {
    expect(resolveQuotaThreshold(cfg(), NONE)).toMatchObject({
      percent: DEFAULT_QUOTA_PICKUP_THRESHOLD_PERCENT,
      source: "environment",
      override: null,
      envVar: "QUOTA_PICKUP_THRESHOLD_PERCENT",
      envValue: null,
    });
  });

  it("takes the environment when it is set, and says so", () => {
    expect(
      resolveQuotaThreshold(cfg({ quotaPickupThresholdPercent: "80" }), NONE)
    ).toMatchObject({ percent: 80, source: "environment", envValue: "80" });
  });

  it("lets an override win, and still names what clearing it falls back to", () => {
    expect(
      resolveQuotaThreshold(cfg({ quotaPickupThresholdPercent: "80" }), {
        quotaPickupThresholdPercent: "95",
      })
    ).toMatchObject({
      percent: 95,
      source: "override",
      override: "95",
      envValue: "80",
    });
  });

  it("refuses an environment value outside the set, and still shows what was set", () => {
    // Collapsing it to "unset" would read back on the screen as a variable
    // nobody had set — the one surprise the provenance line exists to remove.
    const resolved = resolveQuotaThreshold(
      cfg({ quotaPickupThresholdPercent: "93" }),
      NONE
    );

    expect(resolved.percent).toBe(DEFAULT_QUOTA_PICKUP_THRESHOLD_PERCENT);
    expect(resolved.envValue).toBe("93");
  });

  it("falls through rather than throwing on a stored value it cannot read", () => {
    // The column is JSON an older build wrote, so a since-narrowed vocabulary
    // must degrade to the environment rather than gate the fleet on nonsense.
    expect(
      resolveQuotaThreshold(cfg(), {
        quotaPickupThresholdPercent: "ninety",
      }).percent
    ).toBe(DEFAULT_QUOTA_PICKUP_THRESHOLD_PERCENT);
    expect(
      sanitizeOverrides({ quotaPickupThresholdPercent: "ninety" })
    ).toEqual({});
  });

  it("refuses a value outside the offered set, listing what is accepted", () => {
    const parsed = parseSettingsPatch({ quotaPickupThresholdPercent: "93" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("93");
    expect(parsed.error).toContain("90");
  });

  it("refuses a nonsensical percentage rather than clamping it", () => {
    // A clamp would turn "hold at 140%" into a gate the operator never chose.
    expect(parseSettingsPatch({ quotaPickupThresholdPercent: "140" }).ok).toBe(
      false
    );
    expect(parseSettingsPatch({ quotaPickupThresholdPercent: "-1" }).ok).toBe(
      false
    );
  });

  it("is settable, and named in the message that enumerates what is", () => {
    const parsed = parseSettingsPatch({ agentModel: "heavy" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("quotaPickupThresholdPercent");
    expect(SETTABLE_KEYS).toContain("quotaPickupThresholdPercent");
  });
});

describe("ceiling — a UI override may never widen a safety ceiling", () => {
  it("refuses a ceiling by name, saying why it is not a preference", () => {
    for (const key of Object.keys(FIXED_CEILINGS)) {
      const parsed = parseSettingsPatch({ [key]: "1000" });
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.error).toContain("safety ceiling");
    }
  });

  it("keeps every ceiling out of the settable allowlist", () => {
    for (const key of Object.keys(FIXED_CEILINGS)) {
      expect(SETTABLE_KEYS).not.toContain(key);
    }
  });

  it("refuses the whole patch when one key of several is a ceiling", () => {
    // All-or-nothing: half-applying a rejected change is how an operator ends
    // up believing something took effect that didn't.
    expect(
      parseSettingsPatch({ modelTierReview: "light", maxAttempts: "9" }).ok
    ).toBe(false);
  });
});

describe("applying and storing a patch", () => {
  it("sets a field and clears it back to fall-through", () => {
    const set = applySettingsPatch({}, { modelTierReview: "light" });
    expect(set).toEqual({ modelTierReview: "light" });

    const cleared = applySettingsPatch(set, { modelTierReview: null });
    // Removed, not stored as null: "unset" stays exactly one state.
    expect(cleared).toEqual({});
    expect("modelTierReview" in cleared).toBe(false);
  });

  it("leaves the fields a patch does not name alone", () => {
    const next = applySettingsPatch(
      { modelTierReview: "light", modelTierTriage: "light" },
      { modelTierReview: "heavy" }
    );
    expect(next).toEqual({ modelTierReview: "heavy", modelTierTriage: "light" });
  });

  it("drops a stored key or value a newer build no longer accepts", () => {
    // The column is JSON written by an older version; a retired key or a
    // narrowed vocabulary must fall through, not reach the CLI.
    expect(
      sanitizeOverrides({
        modelTierReview: "light",
        modelTierRetired: "heavy",
        modelTierTriage: "turbo",
        modelTierImplement: 7,
      })
    ).toEqual({ modelTierReview: "light" });
  });

  it("reads a missing or malformed column as no overrides at all", () => {
    expect(sanitizeOverrides(null)).toEqual({});
    expect(sanitizeOverrides(undefined)).toEqual({});
    expect(sanitizeOverrides("heavy")).toEqual({});
    expect(sanitizeOverrides([])).toEqual({});
  });

  it("canonicalises a stored alias on read", () => {
    expect(sanitizeOverrides({ modelTierReview: "haiku" })).toEqual({
      modelTierReview: "light",
    });
  });
});

/**
 * The primary-lane field (issue #172). Its vocabulary is the one thing in the
 * registry that is *not* compiled in — the lanes live in a checked-in file read
 * at runtime — so it arrives as context, and these tests pin what happens with
 * and without it.
 */
describe("the primary-lane setting", () => {
  const LANES = { laneIds: ["claude-subscription", "openrouter"] };

  it("accepts a declared lane and stores it canonically", () => {
    const parsed = parseSettingsPatch({ primaryLane: " OpenRouter " }, LANES);
    expect(parsed).toEqual({ ok: true, patch: { primaryLane: "openrouter" } });
  });

  it("refuses a lane that is not declared, listing the ones that are", () => {
    const parsed = parseSettingsPatch({ primaryLane: "kimi" }, LANES);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("kimi");
    expect(parsed.error).toContain("claude-subscription, openrouter");
  });

  it("refuses a value that is not even lane-shaped", () => {
    expect(parseSettingsPatch({ primaryLane: "../../etc/passwd" }, LANES).ok).toBe(
      false
    );
    expect(parseSettingsPatch({ primaryLane: "Bearer sk-x" }, LANES).ok).toBe(false);
    expect(parseSettingsPatch({ primaryLane: "a".repeat(80) }, LANES).ok).toBe(false);
    // Without a catalog only the shape can honestly be asserted — which is
    // exactly why the write path always supplies one, and why the shape is
    // bounded rather than "any string".
    expect(parseSettingsPatch({ primaryLane: "../../etc/passwd" }).ok).toBe(false);
  });

  it("clears back to the environment like any other field", () => {
    expect(parseSettingsPatch({ primaryLane: null }, LANES)).toEqual({
      ok: true,
      patch: { primaryLane: null },
    });
    expect(
      applySettingsPatch({ primaryLane: "openrouter" }, { primaryLane: null })
    ).toEqual({});
  });

  it("keeps a stored lane id when no catalog is supplied, and drops one when it is", () => {
    // Which of the two the read path wants is settled in `settings.ts`: it
    // omits the catalog, so an operator's choice survives a lane the deploy
    // renamed and the *resolver* reports it. The catalog form is the write
    // path's, where an undeclared lane is refused by name.
    expect(sanitizeOverrides({ primaryLane: "openrouter" })).toEqual({
      primaryLane: "openrouter",
    });
    expect(
      sanitizeOverrides({ primaryLane: "retired-lane" }, LANES)
    ).toEqual({});
  });

  it("falls through to AGENT_LANE, and names it", () => {
    expect(
      SETTINGS_FIELDS.primaryLane.envDefault(cfg({ agentLane: "openrouter" }))
    ).toEqual({ envVar: "AGENT_LANE", value: "openrouter" });
  });
});
