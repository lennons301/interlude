import { describe, expect, it } from "vitest";
import type { AppConfig } from "../config";
import { DEFAULT_QUOTA_PICKUP_THRESHOLD_PERCENT } from "../quota/quota-gate";
import {
  MODEL_TIERS,
  TIER_MODEL_IDS,
  normalizeModelTier,
  tierAbove,
  weakerTier,
} from "../model-tiers";
import {
  FIXED_CEILINGS,
  MIN_LANE_ENV_VAR,
  MIN_LANE_FIELD_ORDER,
  MODEL_TIER_FIELD_BY_KIND,
  MODEL_TIER_FIELD_ORDER,
  RESUME_BOUND_OPTIONS,
  SETTINGS_FIELDS,
  SETTABLE_KEYS,
  applySettingsPatch,
  describeMinLaneSettings,
  describeModelTierSettings,
  parseSettingsPatch,
  resolveMinLane,
  resolveModelTier,
  resolveQuotaThreshold,
  resolveResumeBound,
  sanitizeOverrides,
  type SettingsOverrides,
  DERIVED_TIER_KINDS,
  tierCeiling,
  resolveModelTierField,
  tierDerivation,
  isWorkPassKind,
} from "../settings-resolver";
import {
  DEFAULT_MAX_RESUMES_PER_ATTEMPT,
  MAX_RESUMES_CEILING,
} from "../orchestrator/autonomy/budgets";

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
  agentMinLane?: string | null;
  quotaPickupThresholdPercent?: string | null;
} = {}): AppConfig {
  return {
    agentModel: models.agentModel ?? null,
    agentModelReview: models.agentModelReview ?? null,
    agentModelTriage: models.agentModelTriage ?? null,
    agentLane: models.agentLane ?? null,
    agentMinLane: models.agentMinLane ?? null,
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

  it("names the lane's default over an unset field, rather than \"no --model\"", () => {
    // Issue #175: a priced lane answers an unset tier with its own default, so
    // the row must say what will run. Saying "the account default" there would
    // name a model no pass on that lane would ever be given.
    const glm = { heavy: "z-ai/glm-5.3", standard: "z-ai/glm-5.3-flash", light: "z-ai/glm-4.7-flash" };
    const fields = describeModelTierSettings(cfg(), NONE, glm, "standard");
    expect(fields.find((f) => f.key === "modelTierImplement")).toMatchObject({
      source: "environment",
      override: null,
      envValue: null,
      tier: "standard",
      model: "z-ai/glm-5.3-flash",
    });

    // And an unpriced lane keeps the pre-#74 answer: no `--model` at all.
    const plain = describeModelTierSettings(cfg(), NONE);
    expect(plain.find((f) => f.key === "modelTierImplement")).toMatchObject({
      tier: null,
      model: null,
    });
  });

  it("never lets the lane's default displace a pinned model id", () => {
    // `AGENT_MODEL` naming no tier is passed through verbatim by the resolver,
    // so the screen must not claim the lane's tier was chosen instead.
    const glm = { heavy: "z-ai/glm-5.3", standard: "z-ai/glm-5.3-flash", light: "z-ai/glm-4.7-flash" };
    const fields = describeModelTierSettings(
      cfg({ agentModel: "claude-opus-4-8" }),
      NONE,
      glm,
      "standard"
    );
    expect(fields.find((f) => f.key === "modelTierImplement")).toMatchObject({
      tier: null,
      model: "claude-opus-4-8",
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

describe("the quota resume bound (issue #169)", () => {
  /** A config carrying only the field this setting reads. */
  function boundCfg(maxResumesPerAttempt: number | null): AppConfig {
    return { maxResumesPerAttempt } as AppConfig;
  }

  it("falls through to the built-in default with nothing set", () => {
    const resolved = resolveResumeBound(boundCfg(null), NONE);

    expect(resolved.resumes).toBe(DEFAULT_MAX_RESUMES_PER_ATTEMPT);
    expect(resolved.source).toBe("environment");
    expect(resolved.override).toBeNull();
    // Named as unset, not as the default's number: a provenance line claiming
    // the variable holds 3 would send an operator looking for something that
    // is not there.
    expect(resolved.envValue).toBeNull();
    expect(resolved.envVar).toBe("MAX_RESUMES_PER_ATTEMPT");
  });

  it("takes the environment when the variable is set", () => {
    const resolved = resolveResumeBound(boundCfg(1), NONE);

    expect(resolved.resumes).toBe(1);
    expect(resolved.source).toBe("environment");
    expect(resolved.envValue).toBe("1");
  });

  it("lets a UI override win, and says so", () => {
    const resolved = resolveResumeBound(boundCfg(1), { maxResumesPerAttempt: "4" });

    expect(resolved.resumes).toBe(4);
    expect(resolved.source).toBe("override");
    expect(resolved.override).toBe("4");
    // The environment it would fall back to is still reported, which is what
    // makes clearing the override a predictable press.
    expect(resolved.envValue).toBe("1");
  });

  it("accepts zero — a quota pause going straight to a human is a real choice", () => {
    const parsed = parseSettingsPatch({ maxResumesPerAttempt: "0" });

    expect(parsed).toEqual({ ok: true, patch: { maxResumesPerAttempt: "0" } });
    expect(resolveResumeBound(boundCfg(null), { maxResumesPerAttempt: "0" }).resumes).toBe(
      0
    );
  });

  it("rejects a value past the ceiling with a message, never clamping it", () => {
    const parsed = parseSettingsPatch({
      maxResumesPerAttempt: String(MAX_RESUMES_CEILING + 1),
    });

    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.error).toContain(
      `from 0 to ${MAX_RESUMES_CEILING}`
    );
  });

  it("rejects anything that is not a whole count", () => {
    for (const bad of ["-1", "1.5", "three", ""]) {
      expect(parseSettingsPatch({ maxResumesPerAttempt: bad }).ok).toBe(false);
    }
  });

  it("offers exactly the counts the validator accepts", () => {
    // The chips and the rejection message are derived from one ceiling, so a
    // screen can never offer a press the route would refuse.
    expect(RESUME_BOUND_OPTIONS).toEqual(["0", "1", "2", "3", "4", "5"]);
    for (const option of RESUME_BOUND_OPTIONS) {
      expect(parseSettingsPatch({ maxResumesPerAttempt: option }).ok).toBe(true);
    }
  });

  it("drops a stored value a narrowed vocabulary no longer accepts", () => {
    expect(sanitizeOverrides({ maxResumesPerAttempt: "99" })).toEqual({});
    expect(sanitizeOverrides({ maxResumesPerAttempt: "2" })).toEqual({
      maxResumesPerAttempt: "2",
    });
  });

  it("is listed among the settable keys a rejection enumerates", () => {
    expect(SETTABLE_KEYS).toContain("maxResumesPerAttempt");
  });

  it("carries what the screen needs to render and explain the row", () => {
    const view = resolveResumeBound(boundCfg(null), { maxResumesPerAttempt: "2" });

    expect(view.label).toBe(SETTINGS_FIELDS.maxResumesPerAttempt.label);
    expect(view.resumes).toBe(2);
    expect(view.options).toEqual(RESUME_BOUND_OPTIONS);
  });

  it("falls through when a stored value the vocabulary no longer accepts is read", () => {
    // Read defensively, like every other field: the row is JSON written by an
    // older build, and a value past the ceiling must not reach the bound.
    expect(
      resolveResumeBound(boundCfg(1), { maxResumesPerAttempt: "99" }).resumes
    ).toBe(1);
  });
});

describe("a pass kind's minimum lane (issue #176)", () => {
  const LANES = { laneIds: ["claude-subscription", "openrouter-glm"] };

  it("has no floor until one is set — cost routing decides alone", () => {
    // A floor is a *restriction*, so unlike a percentage or a count there is
    // no built-in default: inventing one nobody asked for would quietly stop
    // the fleet using a lane it was given.
    const field = resolveMinLane("implement", cfg(), NONE);
    expect(field.laneId).toBeNull();
    expect(field.source).toBe("environment");
    expect(field.envVar).toBe(MIN_LANE_ENV_VAR);
  });

  it("falls through to AGENT_MIN_LANE, and names it", () => {
    const field = resolveMinLane(
      "review",
      cfg({ agentMinLane: "openrouter-glm" }),
      NONE
    );
    expect(field.laneId).toBe("openrouter-glm");
    expect(field.envValue).toBe("openrouter-glm");
  });

  it("lets an override beat the deployment's own floor, and says so", () => {
    const field = resolveMinLane("implement", cfg({ agentMinLane: "openrouter-glm" }), {
      minLaneImplement: "claude-subscription",
    });
    expect(field.laneId).toBe("claude-subscription");
    expect(field.source).toBe("override");
    // Still shown verbatim, so an operator can see what clearing would give.
    expect(field.envValue).toBe("openrouter-glm");
  });

  it("sets one pass kind's floor without touching another's", () => {
    const overrides: SettingsOverrides = { minLaneImplement: "openrouter-glm" };
    expect(resolveMinLane("implement", cfg(), overrides).laneId).toBe(
      "openrouter-glm"
    );
    expect(resolveMinLane("review", cfg(), overrides).laneId).toBeNull();
    expect(resolveMinLane("triage", cfg(), overrides).laneId).toBeNull();
    expect(resolveMinLane("interactive", cfg(), overrides).laneId).toBeNull();
  });

  it("reads the implement floor for a repair pass — the same attempt continuing", () => {
    const overrides: SettingsOverrides = { minLaneImplement: "openrouter-glm" };
    expect(resolveMinLane("repair", cfg(), overrides).laneId).toBe(
      "openrouter-glm"
    );
  });

  it("refuses a lane that is not declared, listing the ones that are", () => {
    const parsed = parseSettingsPatch({ minLaneReview: "kimi" }, LANES);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("kimi");
    expect(parsed.error).toContain("claude-subscription, openrouter-glm");
  });

  it("refuses a value that is not even lane-shaped", () => {
    expect(parseSettingsPatch({ minLaneImplement: "../../etc/passwd" }).ok).toBe(
      false
    );
    expect(parseSettingsPatch({ minLaneTriage: "Bearer sk-x" }).ok).toBe(false);
  });

  it("clears back to no floor like any other field", () => {
    expect(
      applySettingsPatch({ minLaneImplement: "openrouter-glm" }, {
        minLaneImplement: null,
      })
    ).toEqual({});
  });

  it("ignores a stored value a since-narrowed vocabulary refuses", () => {
    // The defensive read path's rule, inherited: a floor naming nothing falls
    // through to no floor rather than reaching the ranking as a lane id.
    const field = resolveMinLane("implement", cfg(), {
      minLaneImplement: "Bearer sk-x",
    });
    expect(field.laneId).toBeNull();
  });

  it("is settable, and describes every kind in the panel's own order", () => {
    for (const key of MIN_LANE_FIELD_ORDER) {
      expect(SETTABLE_KEYS).toContain(key);
      expect(SETTINGS_FIELDS[key]).toBeDefined();
    }
    expect(describeMinLaneSettings(cfg(), NONE).map((f) => f.key)).toEqual([
      ...MIN_LANE_FIELD_ORDER,
    ]);
  });
});

/**
 * The tier arithmetic a review derives with (issue #201), and the ceiling
 * reading both the pass and the screen judge an explicit setting by. The
 * derivation itself is `resolveAgentModelChoice`'s and is tested with it in
 * `config.test.ts`; this pins the pieces it is built from.
 */
describe("the derived review tier — the rungs and the ceiling (issue #201)", () => {
  it("steps one rung up and stops at the top rather than overflowing", () => {
    expect(tierAbove("light")).toBe("standard");
    expect(tierAbove("standard")).toBe("heavy");
    expect(tierAbove("heavy")).toBe("heavy");
  });

  it("applies a ceiling as the weaker of the two", () => {
    expect(weakerTier("heavy", "light")).toBe("light");
    expect(weakerTier("light", "heavy")).toBe("light");
    expect(weakerTier("standard", "standard")).toBe("standard");
  });

  it("names review as the only derived kind (issue #211)", () => {
    expect(DERIVED_TIER_KINDS).toEqual(["review"]);
    // Repair runs at the run's own tier — the same attempt continuing after
    // the default branch moved, not work judged wrong — and reads the
    // implement field as the implement pass does.
    expect(DERIVED_TIER_KINDS).not.toContain("repair");
    expect(MODEL_TIER_FIELD_BY_KIND.repair).toBe("modelTierImplement");
    // Triage and interactive are chosen settings, never derived.
    expect(DERIVED_TIER_KINDS).not.toContain("triage");
    expect(DERIVED_TIER_KINDS).not.toContain("interactive");
  });

  it("reads a stored override as the ceiling", () => {
    const resolved = resolveModelTierField("modelTierReview", cfg(), {
      modelTierReview: "light",
    });
    expect(tierCeiling(resolved)).toBe("light");
  });

  it("reads a tier named in the field's own variable as the ceiling — the other explicit way", () => {
    const own = resolveModelTierField(
      "modelTierReview",
      cfg({ agentModelReview: "standard" }),
      NONE
    );
    expect(own.envInherited).toBe(false);
    expect(tierCeiling(own)).toBe("standard");
    // The implement field's own variable is the base itself.
    const implement = resolveModelTierField(
      "modelTierImplement",
      cfg({ agentModel: "sonnet" }),
      NONE
    );
    expect(tierCeiling(implement)).toBe("standard");
  });

  it("does not read the base standing in for an unset own variable as a ceiling", () => {
    // The base supplies the review field when its own variable is unset, and
    // the row names it as the fall-back — but it is the implement kind's
    // setting, not the review's, so it bounds nothing.
    const base = resolveModelTierField(
      "modelTierReview",
      cfg({ agentModel: "sonnet", agentModelReview: null }),
      NONE
    );
    expect(base.envVar).toBe("AGENT_MODEL");
    expect(base.tier).toBe("standard");
    expect(base.envInherited).toBe(true);
    expect(tierCeiling(base)).toBeNull();
  });

  it("reads an unset field as no ceiling, so the derivation runs free", () => {
    const resolved = resolveModelTierField(
      "modelTierReview",
      cfg({ agentModel: null, agentModelReview: null }),
      NONE
    );
    expect(tierCeiling(resolved)).toBeNull();
  });

  it("does not read a lane's default over an unset field as a ceiling", () => {
    // A priced lane answers an unset field with its own default tier (issue
    // #175) — what an *underived* pass runs, not a bound anyone chose.
    const resolved = resolveModelTierField(
      "modelTierReview",
      cfg({ agentModel: null, agentModelReview: null }),
      NONE,
      TIER_MODEL_IDS,
      "standard"
    );
    expect(resolved.tier).toBe("standard");
    expect(tierCeiling(resolved)).toBeNull();
  });

  it("does not read a pinned raw model id as a ceiling — it names no tier", () => {
    const resolved = resolveModelTierField(
      "modelTierReview",
      cfg({ agentModelReview: "claude-opus-4-8" }),
      NONE
    );
    expect(resolved.model).toBe("claude-opus-4-8");
    expect(tierCeiling(resolved)).toBeNull();
  });

  it("classifies the review field as capped, pinned or free — the reading the pass makes", () => {
    // The rule is the field's alone: with review the sole derived kind there
    // is no kind to ask about (issue #211).
    const review = (models: Parameters<typeof cfg>[0], overrides = NONE) =>
      tierDerivation(resolveModelTierField("modelTierReview", cfg(models), overrides));

    expect(review({}, { modelTierReview: "light" })).toEqual({ rule: "capped", ceiling: "light" });
    expect(review({ agentModelReview: "heavy" })).toEqual({ rule: "capped", ceiling: "heavy" });
    expect(review({})).toEqual({ rule: "free", ceiling: null });
    // The base is the fall-back, not the review's setting: free.
    expect(review({ agentModel: "standard" })).toEqual({ rule: "free", ceiling: null });
    // A pin on the reviewer's own field is the answer; a pin arriving through
    // the base is not the reviewer's.
    expect(review({ agentModelReview: "claude-opus-4-8" })).toEqual({ rule: "pinned", ceiling: null });
    expect(review({ agentModel: "claude-opus-4-8" })).toEqual({ rule: "free", ceiling: null });
    // #80's work line still decides which kinds a ticket directive reaches.
    expect(isWorkPassKind("repair")).toBe(true);
    expect(isWorkPassKind("review")).toBe(false);
  });

  it("tells the screen which row is a ceiling, for which kind, and at what", () => {
    const fields = describeModelTierSettings(
      cfg({ agentModel: "standard", agentModelReview: null, agentModelTriage: null }),
      { modelTierReview: "light" }
    );
    const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));

    expect(byKey.modelTierReview).toMatchObject({
      chooses: [],
      derived: [{ kind: "review", rule: "capped", ceiling: "light" }],
    });
    // The implement row is a chosen tier for both the implement pass and the
    // repair that continues it — a ceiling on nothing (issue #211).
    expect(byKey.modelTierImplement).toMatchObject({
      chooses: ["implement", "repair"],
      derived: [],
    });
    expect(byKey.modelTierTriage).toMatchObject({ chooses: ["triage"], derived: [] });
    expect(byKey.modelTierInteractive).toMatchObject({
      chooses: ["interactive"],
      derived: [],
    });
    // With the override cleared the review row falls back to the base and
    // reports the derivation free, not capped at the implement tier.
    const [, freeReview] = describeModelTierSettings(cfg({ agentModel: "standard" }), NONE);
    expect(freeReview.envVar).toBe("AGENT_MODEL");
    expect(freeReview.tier).toBe("standard");
    expect(freeReview.derived).toEqual([{ kind: "review", rule: "free", ceiling: null }]);
  });

  it("describes the review row, and only the review row, as a ceiling", () => {
    const fields = describeModelTierSettings(cfg(), NONE);
    const [implement, review] = fields;
    expect(review.key).toBe("modelTierReview");
    expect(review.help).toMatch(/^A ceiling, not a fixed tier/);
    // The implement row is a tier the implement pass and its repair run at
    // (issue #211): it says so, and says nothing of ceilings or rungs.
    expect(implement.key).toBe("modelTierImplement");
    expect(implement.help).toMatch(/repair/);
    expect(implement.help).not.toMatch(/ceiling/);
    expect(implement.help).not.toMatch(/one rung above/);
    for (const field of fields.filter((f) => f.key !== "modelTierReview")) {
      expect(field.help).not.toMatch(/ceiling/);
    }
  });
});
