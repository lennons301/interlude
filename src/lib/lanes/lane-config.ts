/**
 * The execution-lane vocabulary and the pure parser for the checked-in lane
 * file (issue #172).
 *
 * A lane is a named bundle of `{ harness adapter, auth environment variable
 * names, base URL, tier -> model-identifier map, caps, billing kind }`. It is
 * the one place "how does a pass actually get run?" is answered, which is what
 * turns swapping the subscription for a metered API into a configuration
 * change rather than an edit across the container manager, `config.ts` and the
 * autonomy reducer.
 *
 * Pure, exactly as `gates.ts` is: text comes in, a catalog comes out. Reading
 * the file is `catalog.ts`'s job and resolving a lane for a pass is
 * `resolve.ts`'s, so the shape rules below are table-testable with no
 * filesystem and no provider.
 *
 * The parser is strict on purpose. This file names credentials, and it decides
 * what every unattended pass on the box authenticates as; a lane that is
 * *nearly* right is worse than one that fails to load, because the failure is
 * visible and the near-miss silently runs the fleet somewhere unintended. So a
 * document with an unknown adapter, a missing tier, a duplicate id, or a
 * primary naming no declared lane is rejected whole, with a reason.
 */

import { parse as parseYaml } from "yaml";
import { MODEL_TIERS, type ModelTier } from "../model-tiers";
import { isLaneIdShaped } from "./lane-id";

/** The harness adapters that exist. Exactly one ships (issue #172) — the
 * interface is designed against what an OpenCode or Codex adapter would need,
 * but building a second is explicitly out of scope. */
export const LANE_ADAPTERS = ["claude-code"] as const;
export type LaneAdapterId = (typeof LANE_ADAPTERS)[number];

/** Who pays. `subscription` work draws on a fixed-price plan's quota;
 * `metered` work spends real money per token, which is why issue #175's
 * overflow guardrails care about the distinction. */
export const LANE_BILLING_KINDS = ["subscription", "metered"] as const;
export type LaneBilling = (typeof LANE_BILLING_KINDS)[number];

/**
 * One credential the harness needs, as two *names*: the variable the harness
 * reads, and the orchestrator variable holding the secret. They differ more
 * often than not — Claude Code reads `ANTHROPIC_AUTH_TOKEN`, while the
 * OpenRouter key is provisioned as `OPENROUTER_API_KEY` — which is why this is
 * a mapping rather than a list of names.
 */
export interface LaneAuthRef {
  /** The environment variable the harness itself reads. */
  harnessVar: string;
  /** The orchestrator environment variable holding the secret. */
  fromEnv: string;
}

/**
 * A lane's ceilings. One member today, deliberately: the metered-spend cap,
 * declared here and *reported* (resolved lane, settings screen) but enforced
 * by issue #175, which owns the confirm-once-then-cap policy that decides when
 * work may reach a metered lane at all. Declaring it now is what lets that
 * ticket be a policy change rather than a config-shape change; enforcing it
 * here would be inventing half of a policy nobody has ratified.
 */
export interface LaneCaps {
  /** Real money this lane may spend in a local day; null = no cap declared
   * (the honest state for a subscription lane, whose spend is notional). */
  dailyBudgetUsd: number | null;
}

/**
 * What a lane's provider charges, in USD per million tokens (issue #175).
 *
 * Declared per lane because a turn's cost has to come from *somewhere the
 * orchestrator trusts*, and the harness's own figure is not that on a
 * third-party endpoint. Observed on 2026-09-02 against OpenRouter's
 * Anthropic-compatible endpoint: the Claude Code CLI reported
 * `total_cost_usd: 0.194985` for a turn run on a **free** model, computing it
 * at Anthropic list rates ($5/$25 per Mtok) for a model the endpoint had never
 * heard of — 16.7x the paid slug's real price, and infinitely over the free
 * one's. The CLI even says so itself, in the `costBasis: "unknown"` it puts on
 * `modelUsage` where a first-party model reads `"list"`.
 *
 * So every spend guard in the milestone — the per-attempt budget, the daily
 * cap, issue #174's real-money cap — is only as good as this table on a lane
 * that is not Anthropic-direct.
 */
export interface TokenPrices {
  /** USD per million input tokens (uncached). */
  inputPerMTok: number;
  /** USD per million output tokens, thinking tokens included. */
  outputPerMTok: number;
  /**
   * USD per million tokens served from the prompt cache, or null when the
   * provider does not price them apart — in which case they cost the input
   * rate, which is what a provider with no cache discount actually charges.
   */
  cacheReadPerMTok: number | null;
  /** USD per million tokens written to the prompt cache, or null for the same
   * reason (OpenRouter prices no cache write on the GLM family). */
  cacheWritePerMTok: number | null;
}

/**
 * A lane's prices for every tier, or null when it declares none.
 *
 * All three tiers or nothing, exactly as `models` is: a lane that could price
 * `standard` but not `light` would silently fall back to the untrusted harness
 * figure the moment issue #164's ladder stepped down, which is the one moment
 * nobody would be watching the number.
 */
export type LanePrices = Readonly<Record<ModelTier, TokenPrices>>;

export interface LaneDefinition {
  id: string;
  /** Human-facing name for the settings screen. */
  label: string;
  adapter: LaneAdapterId;
  billing: LaneBilling;
  /** Every credential the lane needs, in declaration order. A lane is
   * unavailable unless all of them are set. */
  auth: LaneAuthRef[];
  /** The endpoint the harness talks to; null = the harness's own default. */
  baseUrl: string | null;
  /** What each tier means on this lane. All three tiers, always: a lane that
   * cannot answer "what is light here?" would degrade to nothing under issue
   * #164's ladder. */
  models: Readonly<Record<ModelTier, string>>;
  /**
   * What this lane's provider charges per tier (issue #175), or null to take
   * the harness's own reported cost.
   *
   * Null is the right answer for an Anthropic-direct lane and only for one:
   * there the CLI prices a model it recognises at that model's list rates,
   * which is the figure the fleet wants and the one it has always used. A lane
   * pointing anywhere else declares its prices or its spend is fiction.
   */
  prices: LanePrices | null;
  caps: LaneCaps;
}

export interface LaneCatalog {
  /**
   * The default primary, in preference order: the first lane whose named
   * variables are all present. A list rather than a single id because that is
   * exactly what the platform did before lanes existed (prefer the
   * subscription token, fall back to an API key), and because putting the
   * fallback in the reviewed file is the only place it can be *seen*.
   */
  preference: string[];
  lanes: LaneDefinition[];
}

export type LaneConfigResult =
  | { ok: true; catalog: LaneCatalog }
  | { ok: false; reason: string };

/**
 * An environment-variable *name*. This pattern is the mechanism behind
 * "secrets appear only as names": a pasted `sk-ant-...` does not match, so an
 * inlined credential is a parse error rather than a secret checked into git
 * and served from an API route.
 */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(reason: string): LaneConfigResult {
  return { ok: false, reason };
}

/**
 * Parse the checked-in lane file. Rejects the whole document on any problem —
 * see the module note on why a near-miss is worse than a hard failure.
 */
export function parseLaneConfig(text: string): LaneConfigResult {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    return fail(
      `invalid YAML: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!isMapping(doc)) {
    return fail("document is not a mapping with `lanes` and `primary` keys");
  }

  const rawLanes = doc.lanes;
  if (!Array.isArray(rawLanes) || rawLanes.length === 0) {
    return fail("`lanes` is not a non-empty list of lane definitions");
  }

  const lanes: LaneDefinition[] = [];
  for (const [index, raw] of rawLanes.entries()) {
    const parsed = parseLane(raw, index);
    if ("reason" in parsed) return fail(parsed.reason);
    if (lanes.some((lane) => lane.id === parsed.lane.id)) {
      return fail(`duplicate lane id "${parsed.lane.id}"`);
    }
    lanes.push(parsed.lane);
  }

  const preference = parsePreference(doc.primary);
  if ("reason" in preference) return fail(preference.reason);
  for (const id of preference.ids) {
    if (!lanes.some((lane) => lane.id === id)) {
      return fail(`\`primary\` names lane "${id}", which is not declared`);
    }
  }

  return { ok: true, catalog: { preference: preference.ids, lanes } };
}

type LaneParse = { lane: LaneDefinition } | { reason: string };

function parseLane(raw: unknown, index: number): LaneParse {
  const at = `lane #${index + 1}`;
  if (!isMapping(raw)) return { reason: `${at} is not a mapping` };

  const id = raw.id;
  if (typeof id !== "string" || !isLaneIdShaped(id)) {
    return {
      reason: `${at} has no valid \`id\` (lowercase slug, e.g. "anthropic-api")`,
    };
  }
  const where = `lane "${id}"`;

  const label = raw.label ?? id;
  if (typeof label !== "string" || label === "") {
    return { reason: `${where} has a non-string \`label\`` };
  }

  const adapter = raw.adapter;
  if (
    typeof adapter !== "string" ||
    !(LANE_ADAPTERS as readonly string[]).includes(adapter)
  ) {
    return {
      reason:
        `${where} names adapter "${String(adapter)}" — expected one of ` +
        `${LANE_ADAPTERS.join(", ")}.`,
    };
  }

  const billing = raw.billing;
  if (
    typeof billing !== "string" ||
    !(LANE_BILLING_KINDS as readonly string[]).includes(billing)
  ) {
    return {
      reason:
        `${where} names billing "${String(billing)}" — expected one of ` +
        `${LANE_BILLING_KINDS.join(", ")}.`,
    };
  }

  const auth = parseAuth(raw.auth, where);
  if ("reason" in auth) return auth;

  const baseUrl = parseBaseUrl(raw.base_url, where);
  if ("reason" in baseUrl) return baseUrl;

  const models = parseModels(raw.models, where);
  if ("reason" in models) return models;

  const prices = parsePrices(raw.prices, where);
  if ("reason" in prices) return prices;

  const caps = parseCaps(raw.caps, where);
  if ("reason" in caps) return caps;

  return {
    lane: {
      id,
      label,
      adapter: adapter as LaneAdapterId,
      billing: billing as LaneBilling,
      auth: auth.auth,
      baseUrl: baseUrl.baseUrl,
      models: models.models,
      prices: prices.prices,
      caps: caps.caps,
    },
  };
}

function parseAuth(
  raw: unknown,
  where: string
): { auth: LaneAuthRef[] } | { reason: string } {
  if (!isMapping(raw)) {
    return {
      reason: `${where} has no \`auth\` mapping of HARNESS_VAR: SOURCE_VAR`,
    };
  }
  const entries = Object.entries(raw);
  if (entries.length === 0) {
    return { reason: `${where} declares no auth variables` };
  }
  const auth: LaneAuthRef[] = [];
  for (const [harnessVar, fromEnv] of entries) {
    if (!ENV_NAME.test(harnessVar)) {
      return {
        reason: `${where} auth key "${harnessVar}" is not an environment variable name`,
      };
    }
    // The value must be a NAME, not a secret — this is the check that keeps
    // credentials out of the file (and therefore out of git and out of every
    // API route that serves the catalog).
    if (typeof fromEnv !== "string" || !ENV_NAME.test(fromEnv)) {
      return {
        reason:
          `${where} auth "${harnessVar}" must name an environment variable ` +
          "holding the secret (e.g. OPENROUTER_API_KEY), never the secret itself",
      };
    }
    auth.push({ harnessVar, fromEnv });
  }
  return { auth };
}

function parseBaseUrl(
  raw: unknown,
  where: string
): { baseUrl: string | null } | { reason: string } {
  if (raw === undefined || raw === null) return { baseUrl: null };
  if (typeof raw !== "string" || !raw.startsWith("https://")) {
    return { reason: `${where} has a \`base_url\` that is not an https:// URL` };
  }
  // A trailing slash would double up against whatever path the harness
  // appends, which is a 404 the operator has to debug from the provider's end.
  return { baseUrl: raw.replace(/\/+$/, "") };
}

function parseModels(
  raw: unknown,
  where: string
): { models: Record<ModelTier, string> } | { reason: string } {
  if (!isMapping(raw)) {
    return { reason: `${where} has no \`models\` mapping of tier to model id` };
  }
  const models = {} as Record<ModelTier, string>;
  for (const tier of MODEL_TIERS) {
    const value = raw[tier];
    if (typeof value !== "string" || value.trim() === "") {
      return {
        reason: `${where} has no model identifier for the "${tier}" tier`,
      };
    }
    models[tier] = value.trim();
  }
  const extra = Object.keys(raw).filter(
    (key) => !(MODEL_TIERS as readonly string[]).includes(key)
  );
  if (extra.length > 0) {
    return {
      reason:
        `${where} maps unknown tier(s) ${extra.join(", ")} — expected ` +
        `${MODEL_TIERS.join(", ")}.`,
    };
  }
  return { models };
}

function parsePrices(
  raw: unknown,
  where: string
): { prices: LanePrices | null } | { reason: string } {
  if (raw === undefined || raw === null) return { prices: null };
  if (!isMapping(raw)) {
    return {
      reason: `${where} has a non-mapping \`prices\` (expected one entry per tier)`,
    };
  }

  const prices = {} as Record<ModelTier, TokenPrices>;
  for (const tier of MODEL_TIERS) {
    const entry = raw[tier];
    if (entry === undefined || entry === null) {
      // All three or none — see the note on LanePrices.
      return {
        reason:
          `${where} declares \`prices\` but none for the "${tier}" tier — ` +
          "price every tier or none of them",
      };
    }
    if (!isMapping(entry)) {
      return { reason: `${where} has a non-mapping \`prices.${tier}\`` };
    }
    const input = parsePrice(entry.input, `${where} prices.${tier}.input`);
    if ("reason" in input) return input;
    const output = parsePrice(entry.output, `${where} prices.${tier}.output`);
    if ("reason" in output) return output;
    const cacheRead = parseOptionalPrice(
      entry.cache_read,
      `${where} prices.${tier}.cache_read`
    );
    if ("reason" in cacheRead) return cacheRead;
    const cacheWrite = parseOptionalPrice(
      entry.cache_write,
      `${where} prices.${tier}.cache_write`
    );
    if ("reason" in cacheWrite) return cacheWrite;

    prices[tier] = {
      inputPerMTok: input.price,
      outputPerMTok: output.price,
      cacheReadPerMTok: cacheRead.price,
      cacheWritePerMTok: cacheWrite.price,
    };
  }

  const extra = Object.keys(raw).filter(
    (key) => !(MODEL_TIERS as readonly string[]).includes(key)
  );
  if (extra.length > 0) {
    return {
      reason:
        `${where} prices unknown tier(s) ${extra.join(", ")} — expected ` +
        `${MODEL_TIERS.join(", ")}.`,
    };
  }

  return { prices };
}

/** A required price. Zero is legal — a free model really is free, and reading
 * it as "unpriced" would send the fleet back to the harness's fiction. */
function parsePrice(
  raw: unknown,
  where: string
): { price: number } | { reason: string } {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    return {
      reason: `${where} is not a non-negative number of USD per million tokens`,
    };
  }
  return { price: raw };
}

/** An optional price: absent means "not priced apart", which the cost
 * calculation reads as the input rate rather than as free. */
function parseOptionalPrice(
  raw: unknown,
  where: string
): { price: number | null } | { reason: string } {
  if (raw === undefined || raw === null) return { price: null };
  const parsed = parsePrice(raw, where);
  return "reason" in parsed ? parsed : { price: parsed.price };
}

function parseCaps(
  raw: unknown,
  where: string
): { caps: LaneCaps } | { reason: string } {
  if (raw === undefined || raw === null) {
    return { caps: { dailyBudgetUsd: null } };
  }
  if (!isMapping(raw)) return { reason: `${where} has a non-mapping \`caps\`` };
  const daily = raw.daily_budget_usd;
  if (daily === undefined || daily === null) {
    return { caps: { dailyBudgetUsd: null } };
  }
  if (typeof daily !== "number" || !Number.isFinite(daily) || daily <= 0) {
    return {
      reason: `${where} has a \`caps.daily_budget_usd\` that is not a positive number`,
    };
  }
  return { caps: { dailyBudgetUsd: daily } };
}

function parsePreference(
  raw: unknown
): { ids: string[] } | { reason: string } {
  if (typeof raw === "string") return { ids: [raw] };
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      reason: "`primary` is not a lane id, or a non-empty list of lane ids",
    };
  }
  if (raw.some((id) => typeof id !== "string" || id === "")) {
    return { reason: "`primary` contains a non-string lane id" };
  }
  return { ids: raw as string[] };
}

/** The lane with this id, or null. */
export function findLane(
  catalog: LaneCatalog,
  id: string | null
): LaneDefinition | null {
  if (id === null) return null;
  return catalog.lanes.find((lane) => lane.id === id) ?? null;
}

/** Every declared lane id, in declaration order — for a rejection message that
 * tells the operator what *would* have been accepted. */
export function laneIds(catalog: LaneCatalog): string[] {
  return catalog.lanes.map((lane) => lane.id);
}
