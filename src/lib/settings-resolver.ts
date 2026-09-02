/**
 * The stored-override layer, merged over the environment defaults by a pure
 * resolver (issue #166).
 *
 * Interlude has had two kinds of configuration: env config (`config.ts`),
 * fixed when the process boots, and the durable settings row (`settings.ts`),
 * flipped by a human while the fleet runs. This module is the general
 * mechanism that lets the second *override* the first, field by field:
 *
 * - An **unset** override falls through to the environment default, so a fresh
 *   deployment behaves exactly as it did before this existed. Nothing is
 *   seeded, so "unset" is the state every install starts in.
 * - A **set** override wins, and says so — every field reports its provenance
 *   (`override` vs `environment`) so a surprising effective value is
 *   debuggable from the screen rather than from the logs.
 * - Only the keys in `SETTINGS_FIELDS` may be overridden at all. That
 *   allowlist is how "a UI override may never widen a hard ceiling" is
 *   enforced: the ceilings are not absent by oversight, they are refused by
 *   name (`FIXED_CEILINGS`), with a message saying why.
 * - A disallowed value is **rejected with a message, never silently clamped**
 *   — a clamp turns "I asked for X" into "the fleet quietly did Y", which is
 *   the failure mode this whole layer exists to make visible.
 *
 * Pure: every function here takes the stored overrides and an `AppConfig` and
 * returns a value. Nothing reads the DB or the environment, which is what lets
 * the fall-through, override, rejection, ceiling and provenance rules be
 * table-tested. The *freshness* rule lives at the call sites instead: the
 * resolved settings must be read from the row at the point of use, never
 * cached, because `getConfig()` memoises into a module-level value on first
 * read and a UI override cannot ride on something that never re-reads.
 */

import type { AgentPassKind, AppConfig } from "./config";
import {
  DEFAULT_QUOTA_PICKUP_THRESHOLD_PERCENT,
  QUOTA_THRESHOLD_OPTIONS,
} from "./quota/quota-gate";
import { isLaneIdShaped } from "./lanes/lane-id";
import { MAX_METERED_DAILY_CAP_USD } from "./orchestrator/autonomy/budgets";
import {
  MODEL_TIERS,
  TIER_MODEL_IDS,
  type ModelTier,
  describeModelTierVocabulary,
  normalizeModelTier,
} from "./model-tiers";

/**
 * What each tier means as a model identifier. A parameter since execution
 * lanes (issue #172): the tier is the durable choice, and what it resolves to
 * belongs to the lane the pass will run on. Defaulted to the pre-lane map only
 * so a caller with no lane in hand still resolves something.
 */
export type TierModelIds = Readonly<Record<ModelTier, string>>;

/** The model-tier fields, named as their own union because they share a
 * resolver: asking one of them "what tier is in force?" is meaningful, and
 * asking the lane field the same question is not. */
export type ModelTierSettingKey =
  | "modelTierImplement"
  | "modelTierReview"
  | "modelTierTriage"
  | "modelTierInteractive";

/** The settings a human may override from the UI. A later ticket in issue #164
 * (the per-attempt pause bound) adds a member here and an entry to
 * `SETTINGS_FIELDS`. */
export type SettingKey =
  | ModelTierSettingKey
  | "primaryLane"
  | "quotaPickupThresholdPercent"
  | "meteredDailyCapUsd";

/** What is stored on the settings row: a sparse map, because absent means
 * "fall through to the environment", which is a different thing from any
 * value a field could hold. */
export type SettingsOverrides = Partial<Record<SettingKey, string>>;

/** Where the value in force came from. Two states, because that is the
 * question an operator is actually asking: did *I* set this, or is it the
 * deployment's own default? */
export type SettingSource = "override" | "environment";

/** The environment default a field falls through to, and the variable that
 * actually supplied it — both, because a provenance line that names a variable
 * the operator would find empty is worse than none. */
export interface EnvDefault {
  envVar: string;
  /** Verbatim (null = the variable is unset and the harness resolves its own
   * default). */
  value: string | null;
}

/**
 * What a field needs to know beyond the raw value to judge it. Empty for every
 * field whose vocabulary is compiled in; `laneIds` carries the vocabulary that
 * is *not* — the execution lanes (issue #172) live in a checked-in file read at
 * runtime, so only a caller that has loaded it can say whether a lane id names
 * a real lane. A caller without it gets the syntactic check, which is why the
 * defensive read path may omit it and the write path does not.
 */
export interface SettingsContext {
  laneIds?: readonly string[];
}

export interface SettingSpec {
  key: SettingKey;
  label: string;
  help: string;
  /** The values an override may take, in display order — omitted by a field
   * whose vocabulary is not compiled in (see `SettingsContext`). */
  options?: readonly string[];
  /** Validate a candidate override, returning the canonical form to store, or
   * null to reject it. Never clamps. */
  normalize(raw: string, context: SettingsContext): string | null;
  /** A one-line statement of what is accepted, for a rejection message. */
  vocabulary(context: SettingsContext): string;
  envDefault(config: AppConfig): EnvDefault;
}

function modelTierField(
  key: ModelTierSettingKey,
  label: string,
  help: string,
  envDefault: (config: AppConfig) => EnvDefault
): SettingSpec {
  return {
    key,
    label,
    help,
    options: MODEL_TIERS,
    normalize: (raw) => normalizeModelTier(raw),
    vocabulary: () => describeModelTierVocabulary(),
    envDefault,
  };
}

/** The base every pass kind falls back to. */
function baseModelEnv(config: AppConfig): EnvDefault {
  return { envVar: "AGENT_MODEL", value: config.agentModel };
}

/** A read-heavy pass reads its own variable and falls back to the base, so the
 * row reports whichever actually supplied the value. With both unset it names
 * the row's own variable — the place to set one. */
function cheaperTierEnv(
  envVar: string,
  own: string | null,
  config: AppConfig
): EnvDefault {
  if (own !== null) return { envVar, value: own };
  const base = baseModelEnv(config);
  return base.value !== null ? base : { envVar, value: null };
}

/**
 * The allowlist. A key absent from here cannot be overridden, whatever a
 * request says — which is the mechanism, not a policy check that could be
 * forgotten at one call site.
 */
export const SETTINGS_FIELDS: Readonly<Record<SettingKey, SettingSpec>> = {
  modelTierImplement: modelTierField(
    "modelTierImplement",
    "Implement",
    "The tier an implement pass — and the repair pass that fixes up its PR — runs on. A ticket's own model: directive still outranks it.",
    baseModelEnv
  ),
  modelTierReview: modelTierField(
    "modelTierReview",
    "Review",
    "The tier a review pass runs on. Reviewing is read-heavy, so it is the first thing worth running cheaper than the work it reads.",
    (config) =>
      cheaperTierEnv("AGENT_MODEL_REVIEW", config.agentModelReview, config)
  ),
  modelTierTriage: modelTierField(
    "modelTierTriage",
    "Triage",
    "The tier a triage pass runs on. Shaping the backlog must cost a fraction of implementing it.",
    (config) =>
      cheaperTierEnv("AGENT_MODEL_TRIAGE", config.agentModelTriage, config)
  ),
  modelTierInteractive: modelTierField(
    "modelTierInteractive",
    "Interactive",
    "The tier a chat or generation session runs on — the work you are sitting in front of.",
    baseModelEnv
  ),
  meteredDailyCapUsd: {
    key: "meteredDailyCapUsd",
    label: "Real-money daily cap",
    help:
      "How much cash the fleet may spend through a metered lane in one local day. Subscription work never counts against it — this number measures money, not quota.",
    // No options: a dollar amount is a range, not a vocabulary. The panel
    // renders it as a number field and the rejection message states the range.
    normalize: (raw) => {
      const value = Number(raw.trim());
      if (!Number.isFinite(value) || value <= 0) return null;
      // Refused, never clamped (issue #166's rule), and refused *by name* in
      // FIXED_CEILINGS when someone reaches for the ceiling itself: a press on
      // a web page may not widen a cash ceiling without bound.
      if (value > MAX_METERED_DAILY_CAP_USD) return null;
      // Canonical form: cents, with no trailing zeros, so the row holds one
      // spelling of a given amount and the screen echoes what was typed.
      return String(Math.round(value * 100) / 100);
    },
    vocabulary: () =>
      `a positive dollar amount up to $${MAX_METERED_DAILY_CAP_USD}`,
    envDefault: (config) => ({
      envVar: METERED_CAP_ENV_VAR,
      value: String(config.meteredDailyCapUsd),
    }),
  },
  primaryLane: {
    key: "primaryLane",
    label: "Primary lane",
    help:
      "Which execution lane every pass runs on — the harness, the endpoint and the credentials behind each tier.",
    // No compiled-in options: the lanes are declared in a checked-in file read
    // at runtime, so the vocabulary arrives through `SettingsContext` instead.
    normalize: (raw, context) => {
      const value = raw.trim().toLowerCase();
      // Shape from the same leaf module the lane file validates with, so the
      // two can't drift. Membership in the real catalog is the check that
      // matters, and it needs a `SettingsContext` this caller may not have.
      if (!isLaneIdShaped(value)) return null;
      // With the catalog in hand, a lane that does not exist is rejected by
      // name rather than stored and quietly ignored later; without it, the
      // shape check is all that can honestly be asserted.
      if (context.laneIds && !context.laneIds.includes(value)) return null;
      return value;
    },
    vocabulary: (context) =>
      context.laneIds
        ? `the declared lanes: ${context.laneIds.join(", ")}`
        : "a lane id declared in lanes.yaml",
    envDefault: (config) => ({ envVar: "AGENT_LANE", value: config.agentLane }),
  },
  quotaPickupThresholdPercent: {
    key: "quotaPickupThresholdPercent",
    label: "Quota pickup threshold",
    help:
      "How full the account's quota window may get before the fleet stops claiming new tickets. Work already in flight always finishes, and a parked run still resumes. At 100 the gate closes only when the account is already being rejected.",
    // A fixed set rather than a free number: the spread offered is finer than
    // the decision it feeds, so nothing useful is out of reach, and a value
    // outside it is refused *with the list* rather than clamped.
    options: QUOTA_THRESHOLD_OPTIONS,
    normalize: (raw) => {
      const value = raw.trim();
      return (QUOTA_THRESHOLD_OPTIONS as readonly string[]).includes(value)
        ? value
        : null;
    },
    vocabulary: () => QUOTA_THRESHOLD_OPTIONS.join(", "),
    envDefault: (config) => ({
      envVar: "QUOTA_PICKUP_THRESHOLD_PERCENT",
      // Verbatim, including a value this build refuses: the screen's job is to
      // say what the deployment actually set, and a refused one shown beside
      // the default now in force is how an operator finds their typo.
      value: config.quotaPickupThresholdPercent,
    }),
  },
};

/** Display order for the model-tier panel. Kept beside the registry so a new
 * field is placed deliberately rather than wherever object iteration puts it.
 * The lane field is deliberately not here: it needs the lane catalog to render
 * at all, so it has its own view model (`describeLanes`) and its own panel. */
export const MODEL_TIER_FIELD_ORDER: readonly ModelTierSettingKey[] = [
  "modelTierImplement",
  "modelTierReview",
  "modelTierTriage",
  "modelTierInteractive",
];

/** Every settable key, for a rejection message that tells the operator what
 * *would* have been accepted. Derived, so a field added to the registry cannot
 * be left out of the message that is supposed to enumerate them. */
export const SETTABLE_KEYS: readonly SettingKey[] = [
  ...MODEL_TIER_FIELD_ORDER,
  "primaryLane",
  "quotaPickupThresholdPercent",
  "meteredDailyCapUsd",
];

/**
 * Settings that are deliberately *not* settable here, by name, so a request to
 * move one gets an answer rather than "unknown key". These are safety
 * ceilings, not preferences: a UI override may never widen them (issue #164
 * puts it as "the maximum per-attempt budget, the estate daily cap and the
 * attempt count stay in code and environment"). Anything naming a credential
 * is excluded for the same reason and never gets a key at all.
 */
export const FIXED_CEILINGS: Readonly<Record<string, string>> = {
  // Keyed by the camelCase of the constant that holds each one, so a caller
  // guessing at a name lands on the explanation rather than "unknown key".
  maxAttemptBudgetUsd: "the maximum per-attempt budget",
  maxBudgetUsd: "the maximum per-attempt budget",
  dailyAutonomousCapUsd: "the estate daily spend cap",
  maxAttempts: "the per-ticket attempt count",
  // The real-money cap itself IS settable (`meteredDailyCapUsd`); what is not
  // is the ceiling that bounds it (issue #174).
  maxMeteredDailyCapUsd: "the ceiling on the real-money daily cap",
};

function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS_FIELDS, key);
}

/**
 * Read stored overrides defensively. The row is JSON written by an older
 * version of this code, so it may carry a key that has since been retired or a
 * value a since-narrowed vocabulary no longer accepts; either falls through to
 * the environment rather than failing the read or reaching the CLI. The write
 * path rejects both loudly — this one only has to not make things worse.
 */
export function sanitizeOverrides(
  raw: unknown,
  context: SettingsContext = {}
): SettingsOverrides {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const clean: SettingsOverrides = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSettingKey(key) || typeof value !== "string") continue;
    const normalized = SETTINGS_FIELDS[key].normalize(value, context);
    if (normalized !== null) clean[key] = normalized;
  }
  return clean;
}

/** A patch: a value sets an override, `null` clears it back to the
 * environment default. */
export type SettingsPatch = Partial<Record<SettingKey, string | null>>;

export type PatchParse =
  | { ok: true; patch: SettingsPatch }
  | { ok: false; error: string };

/**
 * Validate a request body into a patch. Every rejection carries the reason and
 * what would have been accepted: the point of refusing rather than clamping is
 * that the operator learns what the fleet will actually do.
 */
export function parseSettingsPatch(
  body: unknown,
  context: SettingsContext = {}
): PatchParse {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Body must be an object of settings to change" };
  }

  const entries = Object.entries(body as Record<string, unknown>);
  if (entries.length === 0) {
    return { ok: false, error: "No settings given to change" };
  }

  const patch: SettingsPatch = {};
  for (const [key, value] of entries) {
    const ceiling = FIXED_CEILINGS[key];
    if (ceiling !== undefined) {
      return {
        ok: false,
        error:
          `"${key}" is ${ceiling} — a safety ceiling, not a preference. ` +
          "It stays in code and environment and cannot be widened from here.",
      };
    }
    if (!isSettingKey(key)) {
      return {
        ok: false,
        error:
          `"${key}" is not a settable setting. Settable: ` +
          `${SETTABLE_KEYS.join(", ")}.`,
      };
    }
    if (value === null) {
      patch[key] = null;
      continue;
    }
    if (typeof value !== "string") {
      return {
        ok: false,
        error: `"${key}" must be a string, or null to clear the override.`,
      };
    }
    const spec = SETTINGS_FIELDS[key];
    const normalized = spec.normalize(value, context);
    if (normalized === null) {
      return {
        ok: false,
        error:
          `"${value}" is not a valid ${key} — expected one of ` +
          `${spec.vocabulary(context)}.`,
      };
    }
    patch[key] = normalized;
  }

  return { ok: true, patch };
}

/** Apply a validated patch. Pure: a cleared key is removed, so "unset" stays
 * one state rather than becoming a stored null that later reads must decode. */
export function applySettingsPatch(
  current: SettingsOverrides,
  patch: SettingsPatch
): SettingsOverrides {
  const next: SettingsOverrides = { ...current };
  for (const [key, value] of Object.entries(patch) as [
    SettingKey,
    string | null,
  ][]) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

/** The variable supplying the deployment's own real-money daily cap. Declared
 * here, beside the field that falls through to it, and re-exported by the
 * money guards so both halves name one variable. */
export const METERED_CAP_ENV_VAR = "METERED_DAILY_CAP_USD";

/** The real-money daily cap the settings layer is asking for, before a lane's
 * own declared cap is allowed to bind it down (issue #174 — see
 * `resolveMeteredCap`, the only caller, which owns that half). The merge lives
 * here with every other field's, so there is one place an override beats the
 * environment. */
export function resolveMeteredCapSetting(
  config: AppConfig,
  overrides: SettingsOverrides
): {
  usd: number;
  source: SettingSource;
  /** The stored override verbatim, or null when the field falls through. */
  override: string | null;
  envVar: string;
  envUsd: number;
} {
  const spec = SETTINGS_FIELDS.meteredDailyCapUsd;
  const { envVar } = spec.envDefault(config);
  const envUsd = config.meteredDailyCapUsd;
  // Normalised through the field's own spec rather than parsed again here: a
  // stored value an older build wrote (or one a since-lowered ceiling no
  // longer accepts) falls through to the environment exactly as every other
  // override does, instead of reaching the cap as an unvalidated number.
  const stored = overrides.meteredDailyCapUsd ?? null;
  const normalized = stored === null ? null : spec.normalize(stored, {});
  if (normalized === null) {
    return { usd: envUsd, source: "environment", override: null, envVar, envUsd };
  }
  return {
    usd: Number(normalized),
    source: "override",
    override: normalized,
    envVar,
    envUsd,
  };
}

/**
 * A model-tier field, resolved. `model` is what reaches the CLI's `--model`
 * flag; `tier` is the same choice in the durable vocabulary, and is null only
 * when the environment pins a raw model id that names no tier — which stays
 * legal and is passed through verbatim, because a deployment that pins
 * `claude-opus-4-8` today must keep running it.
 */
export interface ResolvedModelTier {
  key: ModelTierSettingKey;
  tier: ModelTier | null;
  model: string | null;
  source: SettingSource;
  /** The stored override, or null when the field falls through. */
  override: ModelTier | null;
  /** The variable that supplies (or would supply) the environment default. */
  envVar: string;
  /** The environment default this field falls through to, verbatim. */
  envValue: string | null;
}

/** Which field decides a pass's tier. `repair` is implement-shaped — it is the
 * same attempt continuing — so it deliberately reads the implement field
 * rather than getting a knob of its own. */
export const MODEL_TIER_FIELD_BY_KIND: Readonly<
  Record<AgentPassKind, ModelTierSettingKey>
> = {
  implement: "modelTierImplement",
  repair: "modelTierImplement",
  review: "modelTierReview",
  triage: "modelTierTriage",
  interactive: "modelTierInteractive",
};

/**
 * The model-tier setting in force for one pass kind. Each field falls through
 * to *its own* environment default, never to another field's override: an
 * override says "this pass kind runs here", and quietly spreading it to the
 * others is how a cheap triage default would end up deciding what the reviewer
 * runs on.
 */
export function resolveModelTier(
  kind: AgentPassKind,
  config: AppConfig,
  overrides: SettingsOverrides,
  tierModels: TierModelIds = TIER_MODEL_IDS
): ResolvedModelTier {
  return resolveModelTierField(
    MODEL_TIER_FIELD_BY_KIND[kind],
    config,
    overrides,
    tierModels
  );
}

/** The same resolution addressed by field rather than by pass kind — what the
 * settings screen reads, and the one place the merge itself is written. */
export function resolveModelTierField(
  key: ModelTierSettingKey,
  config: AppConfig,
  overrides: SettingsOverrides,
  tierModels: TierModelIds = TIER_MODEL_IDS
): ResolvedModelTier {
  const spec = SETTINGS_FIELDS[key];
  const { envVar, value: envValue } = spec.envDefault(config);
  const override = normalizeModelTier(overrides[key] ?? null);

  if (override !== null) {
    return {
      key,
      tier: override,
      model: tierModels[override],
      source: "override",
      override,
      envVar,
      envValue,
    };
  }

  // A tier named in the environment goes through the same map an override
  // does — `AGENT_MODEL=heavy` must reach the CLI as a model it accepts, not
  // as the word "heavy". Anything that names no tier is a pinned model id and
  // is passed through verbatim.
  const envTier = normalizeModelTier(envValue);
  return {
    key,
    tier: envTier,
    model: envTier !== null ? tierModels[envTier] : envValue,
    source: "environment",
    override: null,
    envVar,
    envValue,
  };
}

/**
 * The quota admission threshold in force (issue #171), and where it came from.
 *
 * Its own resolver and its own view, like the lane field's — it shares the
 * registry (which is the allowlist, and so the mechanism that decides what is
 * settable at all) but not the model-tier field view, because asking a
 * percentage "what tier is in force?" is not a meaningful question.
 *
 * Three layers, where a tier has two: a stored override, then the environment
 * variable, then the built-in default. The third is what makes this field
 * different — a tier may resolve to "pass no `--model` and let the harness
 * decide", but a gate needs a number. The environment is read through the same
 * `normalize` an override is, so a typo there is refused rather than clamped
 * and falls through here, while still being *shown* verbatim: a refused value
 * collapsed to "unset" would read back on the screen as a variable nobody had
 * set, which is the one surprise the provenance line exists to remove.
 */
export interface QuotaThresholdView {
  /** The percentage in force — what the gate actually judges against. */
  percent: number;
  source: SettingSource;
  /** The stored override, or null when the field falls through. */
  override: string | null;
  /** The values an override may take, in display order. */
  options: readonly string[];
  label: string;
  help: string;
  envVar: string;
  /** The environment default, verbatim (null = unset). */
  envValue: string | null;
}

export function resolveQuotaThreshold(
  config: AppConfig,
  overrides: SettingsOverrides
): QuotaThresholdView {
  const spec = SETTINGS_FIELDS.quotaPickupThresholdPercent;
  const { envVar, value: envValue } = spec.envDefault(config);
  const stored = overrides.quotaPickupThresholdPercent ?? null;
  const override = stored === null ? null : spec.normalize(stored, {});
  const fromEnv = envValue === null ? null : spec.normalize(envValue, {});
  const inForce = override ?? fromEnv;

  return {
    percent:
      inForce === null
        ? DEFAULT_QUOTA_PICKUP_THRESHOLD_PERCENT
        : parseInt(inForce, 10),
    source: override !== null ? "override" : "environment",
    override,
    options: spec.options ?? [],
    label: spec.label,
    help: spec.help,
    envVar,
    envValue,
  };
}

/** One field as the settings screen shows it: what is in force, where it came
 * from, and what clearing it would fall back to. */
export interface SettingFieldView {
  key: ModelTierSettingKey;
  label: string;
  help: string;
  options: readonly string[];
  source: SettingSource;
  /** The stored override, or null when the field falls through. */
  override: string | null;
  /** The variable that supplies (or would supply) the environment default. */
  envVar: string;
  /** The environment default, verbatim (null = unset). */
  envValue: string | null;
  /** The tier in force, or null when the environment pins a raw model id. */
  tier: ModelTier | null;
  /** What actually reaches the harness (null = no `--model`; the CLI resolves
   * the account default, which is the pre-#74 behaviour). */
  model: string | null;
}

/**
 * Every field, resolved for display. The API and the screen both read this, so
 * the value the UI shows is the value the resolver would hand a pass — which
 * is why `tierModels` must be the *primary lane's* map (issue #172). Show the
 * pre-lane map while the fleet runs on OpenRouter and the row would name a
 * model no pass will ever run.
 */
export function describeModelTierSettings(
  config: AppConfig,
  overrides: SettingsOverrides,
  tierModels: TierModelIds = TIER_MODEL_IDS
): SettingFieldView[] {
  return MODEL_TIER_FIELD_ORDER.map((key) => {
    const spec = SETTINGS_FIELDS[key];
    const resolved = resolveModelTierField(key, config, overrides, tierModels);
    return {
      key,
      label: spec.label,
      help: spec.help,
      envVar: resolved.envVar,
      options: spec.options ?? [],
      source: resolved.source,
      override: resolved.override,
      envValue: resolved.envValue,
      tier: resolved.tier,
      model: resolved.model,
    };
  });
}
