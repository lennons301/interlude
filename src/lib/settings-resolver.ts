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
import {
  MODEL_TIERS,
  type ModelTier,
  describeModelTierVocabulary,
  normalizeModelTier,
  tierModelId,
} from "./model-tiers";

/** The settings a human may override from the UI. Later tickets in issue #164
 * (the overflow daily cap, the per-attempt pause bound) add members here and an
 * entry to `SETTINGS_FIELDS`. */
export type SettingKey =
  | "modelTierImplement"
  | "modelTierReview"
  | "modelTierTriage"
  | "modelTierInteractive"
  | "quotaPickupThresholdPercent";

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
 * What a resolved field *means*, beyond the string that is stored — the part
 * that differs field by field, kept as a discriminated union so a screen that
 * renders a model tier cannot accidentally render a percentage through the
 * same words. The shared half (provenance, options, the variable it falls back
 * to) stays flat on {@link SettingFieldView}, because that half is identical
 * for every setting and is the reason this layer is general at all.
 */
export type SettingDetail =
  | {
      kind: "model-tier";
      /** The tier in force, or null when the environment pins a raw model id. */
      tier: ModelTier | null;
      /** What actually reaches the harness (null = no `--model`). */
      model: string | null;
    }
  | {
      kind: "percent";
      /** The value in force. Always a number: a percentage has no "let
       * something downstream decide" state, so an unset override and an unset
       * variable both land on the field's own built-in default. */
      percent: number;
    };

export interface SettingSpec {
  key: SettingKey;
  label: string;
  help: string;
  /** The values an override may take, in display order. */
  options: readonly string[];
  /** Validate a candidate override, returning the canonical form to store, or
   * null to reject it. Never clamps. */
  normalize(raw: string): string | null;
  /** A one-line statement of what is accepted, for a rejection message. */
  vocabulary(): string;
  envDefault(config: AppConfig): EnvDefault;
  /** The resolved meaning of the value in force — see {@link SettingDetail}. */
  detail(config: AppConfig, overrides: SettingsOverrides): SettingDetail;
}

function modelTierField(
  key: SettingKey,
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
    vocabulary: describeModelTierVocabulary,
    envDefault,
    detail: (config, overrides) => {
      const resolved = resolveModelTierField(key, config, overrides);
      return { kind: "model-tier", tier: resolved.tier, model: resolved.model };
    },
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
 * The quota admission threshold (issue #171): the utilization at or above
 * which the fleet stops claiming new tickets.
 *
 * Not a safety ceiling, which is why it is settable at all — it only ever makes
 * the fleet do *less*. The one thing it cannot turn off is the outright
 * rejection: at 100 the gate still closes when the account is already refusing
 * work, because a claim made then cannot run whatever a threshold says.
 */
function quotaThresholdField(): SettingSpec {
  return {
    key: "quotaPickupThresholdPercent",
    label: "Quota pickup threshold",
    help:
      "How full the account's quota window may get before the fleet stops claiming new tickets. Work already in flight always finishes, and a parked run still resumes. At 100 the gate closes only when the account is already being rejected.",
    options: QUOTA_THRESHOLD_OPTIONS,
    normalize: (raw) => {
      const trimmed = raw.trim();
      return (QUOTA_THRESHOLD_OPTIONS as readonly string[]).includes(trimmed)
        ? trimmed
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
    detail: (config, overrides) => ({
      kind: "percent",
      percent: resolveQuotaThreshold(config, overrides).percent,
    }),
  };
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
  quotaPickupThresholdPercent: quotaThresholdField(),
};

/** Display order for the screen and the API. Kept beside the registry so a new
 * field is placed deliberately rather than wherever object iteration puts it. */
export const SETTINGS_FIELD_ORDER: readonly SettingKey[] = [
  "modelTierImplement",
  "modelTierReview",
  "modelTierTriage",
  "modelTierInteractive",
  "quotaPickupThresholdPercent",
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
export function sanitizeOverrides(raw: unknown): SettingsOverrides {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const clean: SettingsOverrides = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSettingKey(key) || typeof value !== "string") continue;
    const normalized = SETTINGS_FIELDS[key].normalize(value);
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
export function parseSettingsPatch(body: unknown): PatchParse {
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
          `${SETTINGS_FIELD_ORDER.join(", ")}.`,
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
    const normalized = spec.normalize(value);
    if (normalized === null) {
      return {
        ok: false,
        error:
          `"${value}" is not a valid ${key} — expected one of ` +
          `${spec.vocabulary()}.`,
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

/**
 * A model-tier field, resolved. `model` is what reaches the CLI's `--model`
 * flag; `tier` is the same choice in the durable vocabulary, and is null only
 * when the environment pins a raw model id that names no tier — which stays
 * legal and is passed through verbatim, because a deployment that pins
 * `claude-opus-4-8` today must keep running it.
 */
export interface ResolvedModelTier {
  key: SettingKey;
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
  Record<AgentPassKind, SettingKey>
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
  overrides: SettingsOverrides
): ResolvedModelTier {
  return resolveModelTierField(MODEL_TIER_FIELD_BY_KIND[kind], config, overrides);
}

/** The same resolution addressed by field rather than by pass kind — what the
 * settings screen reads, and the one place the merge itself is written. */
export function resolveModelTierField(
  key: SettingKey,
  config: AppConfig,
  overrides: SettingsOverrides
): ResolvedModelTier {
  const spec = SETTINGS_FIELDS[key];
  const { envVar, value: envValue } = spec.envDefault(config);
  const override = normalizeModelTier(overrides[key] ?? null);

  if (override !== null) {
    return {
      key,
      tier: override,
      model: tierModelId(override),
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
    model: envTier !== null ? tierModelId(envTier) : envValue,
    source: "environment",
    override: null,
    envVar,
    envValue,
  };
}

/**
 * The quota admission threshold in force (issue #171), and where it came from.
 *
 * Three layers, in the order every other field uses: a stored override, then
 * the environment variable, then the built-in default. The third layer is what
 * makes this field different from a model tier — a tier may resolve to "no
 * `--model` at all" and let the CLI decide, but a gate needs a number, so
 * "unset everywhere" lands on {@link DEFAULT_QUOTA_PICKUP_THRESHOLD_PERCENT}
 * rather than on nothing. Both the environment reader and the override reader
 * refuse a value outside the vocabulary, so an unreadable one falls through
 * here exactly as an absent one does.
 */
export interface ResolvedQuotaThreshold {
  percent: number;
  source: SettingSource;
  /** The stored override, or null when the field falls through. */
  override: number | null;
  envVar: string;
  /** The environment default, verbatim (null = unset). */
  envValue: string | null;
}

export function resolveQuotaThreshold(
  config: AppConfig,
  overrides: SettingsOverrides
): ResolvedQuotaThreshold {
  const spec = SETTINGS_FIELDS.quotaPickupThresholdPercent;
  const { envVar, value: envValue } = spec.envDefault(config);
  const stored = overrides.quotaPickupThresholdPercent ?? null;
  const override = stored === null ? null : spec.normalize(stored);

  if (override !== null) {
    return {
      percent: parseInt(override, 10),
      source: "override",
      override: parseInt(override, 10),
      envVar,
      envValue,
    };
  }

  // The environment is read through the same `normalize` an override is, so a
  // typo there is refused rather than clamped, exactly as it would be from the
  // UI — and falls through to the built-in default, which is the third layer a
  // gate needs and a model tier does not.
  const fromEnv = envValue === null ? null : spec.normalize(envValue);
  return {
    percent:
      fromEnv === null
        ? DEFAULT_QUOTA_PICKUP_THRESHOLD_PERCENT
        : parseInt(fromEnv, 10),
    source: "environment",
    override: null,
    envVar,
    envValue,
  };
}

/** One field as the settings screen shows it: what is in force, where it came
 * from, and what clearing it would fall back to. */
export interface SettingFieldView {
  key: SettingKey;
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
  /** What the value in force means — see {@link SettingDetail}. Discriminated,
   * so a panel that renders tiers and a panel that renders a percentage each
   * narrow to the fields they actually have. */
  detail: SettingDetail;
}

/** Every field, resolved for display. The API and the screen both read this,
 * so the value the UI shows is the value the resolver would hand a pass. */
export function describeSettings(
  config: AppConfig,
  overrides: SettingsOverrides
): SettingFieldView[] {
  return SETTINGS_FIELD_ORDER.map((key) => {
    const spec = SETTINGS_FIELDS[key];
    const { envVar, value: envValue } = spec.envDefault(config);
    const stored = overrides[key] ?? null;
    const override = stored === null ? null : spec.normalize(stored);
    return {
      key,
      label: spec.label,
      help: spec.help,
      envVar,
      options: spec.options,
      source: override !== null ? "override" : "environment",
      override,
      envValue,
      detail: spec.detail(config, overrides),
    };
  });
}
