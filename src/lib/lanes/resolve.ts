/**
 * Lane resolution (issue #172): a pure function of `(lane config, pass kind,
 * resolved settings)` producing the concrete auth values, base URL, model
 * identifier and caps one exec will run under.
 *
 * Pure means the environment is a *parameter*. Nothing here reads
 * `process.env`, the settings row or the filesystem, which is what lets every
 * rule below be tested with no provider and no credential:
 *
 * - **Availability is a report, not a fallback.** A lane whose named variables
 *   are absent resolves to `ok: false` naming them, before a container is
 *   created — rather than a live exec dying inside the harness with "Not
 *   logged in", which is the failure this replaces.
 * - **An explicit choice is honoured, even when it is broken.** A lane picked
 *   on the settings screen (or pinned in `AGENT_LANE`) is never silently
 *   swapped for a working one: routing around an operator's choice is how a
 *   fleet ends up spending real money nobody asked it to. Only the *unset*
 *   default walks the file's preference order.
 * - **Secrets are read here and nowhere else.** The values leave as a
 *   `harness variable -> value` map that goes straight into one exec's
 *   environment. Nothing on this path is persisted, and the view model below
 *   deliberately carries variable *names* only, because a project API route
 *   has previously leaked a stored token in cleartext.
 */

import type { AgentPassKind, AppConfig } from "../config";
import { resolveAgentModelChoice } from "../config";
import type { ModelTier } from "../model-tiers";
import type { SettingsOverrides } from "../settings-resolver";
import {
  findLane,
  laneIds,
  type LaneBilling,
  type LaneCatalog,
  type LaneCaps,
  type LaneDefinition,
  type LaneAdapterId,
} from "./lane-config";

/** Just enough of `process.env` to be handed a plain object in a test. */
export type LaneEnv = Readonly<Record<string, string | undefined>>;

/** Where the primary-lane choice came from. `preference` is the file's own
 * ordered default — the state a fresh deployment is in. */
export type LaneChoiceSource = "override" | "environment" | "preference";

export interface PrimaryLaneChoice {
  /** The lane in force; null only when the catalog declares no preference that
   * resolves (which the parser makes unreachable for a valid file). */
  laneId: string | null;
  source: LaneChoiceSource;
  /**
   * A stored override or `AGENT_LANE` value naming no declared lane. Reported
   * rather than obeyed or silently dropped: the file is version-controlled and
   * the override is not, so a lane renamed in a deploy leaves a choice
   * dangling, and the operator needs to see that they are not on the lane they
   * think they are.
   */
  unknownChoice: string | null;
}

/** Every named variable a lane needs that the environment does not supply. */
export function laneMissingEnv(lane: LaneDefinition, env: LaneEnv): string[] {
  return lane.auth
    .filter((ref) => {
      const value = env[ref.fromEnv];
      return value === undefined || value === "";
    })
    .map((ref) => ref.fromEnv);
}

/** Can this lane run right now? */
export function laneIsAvailable(lane: LaneDefinition, env: LaneEnv): boolean {
  return laneMissingEnv(lane, env).length === 0;
}

export interface PrimaryLaneInput {
  catalog: LaneCatalog;
  /** The stored `primaryLane` setting, if a human has picked one. */
  override: string | null;
  /** `AGENT_LANE` — the deployment's own default. */
  envLane: string | null;
  env: LaneEnv;
}

/**
 * Which lane is primary. Override, then the environment, then the file's
 * preference order — the same three-layer shape every other setting has, with
 * one difference: only the preference layer consults availability, because
 * only it is a default rather than a decision.
 */
export function choosePrimaryLane({
  catalog,
  override,
  envLane,
  env,
}: PrimaryLaneInput): PrimaryLaneChoice {
  const explicit: [string | null, LaneChoiceSource][] = [
    [override, "override"],
    [envLane, "environment"],
  ];

  let unknownChoice: string | null = null;
  for (const [value, source] of explicit) {
    if (value === null || value === "") continue;
    if (findLane(catalog, value) !== null) {
      return { laneId: value, source, unknownChoice: null };
    }
    // Keep looking (an unknown override still lets AGENT_LANE decide), but
    // remember the first dangling choice so the screen can say so.
    unknownChoice ??= value;
  }

  const preferred = catalog.preference
    .map((id) => findLane(catalog, id))
    .filter((lane): lane is LaneDefinition => lane !== null);
  const available = preferred.find((lane) => laneIsAvailable(lane, env));
  // With none available, still name the first preference: something has to be
  // reported as the lane that would run, and "unavailable, set X" is a more
  // useful answer than "no lane".
  const chosen = available ?? preferred[0] ?? null;

  return {
    laneId: chosen?.id ?? null,
    source: "preference",
    unknownChoice,
  };
}

/**
 * One lane, resolved for one pass: everything an adapter needs to build an
 * exec, and nothing it does not.
 */
export interface ResolvedLane {
  id: string;
  label: string;
  adapter: LaneAdapterId;
  billing: LaneBilling;
  /** Harness environment variable -> the secret it carries. Exec-scoped by
   * contract: this map may only ever reach one `docker exec`'s Env. */
  auth: Readonly<Record<string, string>>;
  /** The endpoint the harness talks to; null = the harness's own default. */
  baseUrl: string | null;
  /** The tier this pass runs at; null when the environment pins a raw model id
   * that names no tier (still legal — see `pinnedModel`). */
  tier: ModelTier | null;
  /**
   * The concrete model identifier for the pass. Null means "pass no model
   * flag" and let the harness resolve its own default, which is the behaviour
   * an install that has never configured a model has always had.
   */
  model: string | null;
  caps: LaneCaps;
}

export type LaneResolution =
  | { ok: true; lane: ResolvedLane; choice: PrimaryLaneChoice }
  | { ok: false; reason: string; choice: PrimaryLaneChoice };

export interface ResolveLaneInput {
  catalog: LaneCatalog;
  kind: AgentPassKind;
  config: AppConfig;
  /** A ticket's `model:` directive, already normalised to a tier by the
   * directive parser; null for a pass that carries none. */
  ticketModel: string | null;
  overrides: SettingsOverrides;
  env: LaneEnv;
}

/**
 * The lane one pass runs on. The model identifier is the lane's answer for the
 * tier the settings layer chose — the tier is the durable choice a human makes
 * and the lane is what that means here, which is the whole reason issue #166
 * moved the vocabulary to tiers before this ticket existed.
 *
 * One deliberate exception: an environment that pins a raw model id naming no
 * tier (`AGENT_MODEL=claude-opus-4-8`) still passes through verbatim. Such a
 * deployment is pinning an identifier it knows its endpoint accepts, and
 * translating it through a lane map we do not have a tier for would be a
 * guess.
 */
export function resolveLane({
  catalog,
  kind,
  config,
  ticketModel,
  overrides,
  env,
}: ResolveLaneInput): LaneResolution {
  const choice = choosePrimaryLane({
    catalog,
    override: overrides.primaryLane ?? null,
    envLane: config.agentLane,
    env,
  });

  const lane = findLane(catalog, choice.laneId);
  if (lane === null) {
    return {
      ok: false,
      choice,
      reason:
        "no execution lane is declared — check `primary` in lanes.yaml " +
        `(declared lanes: ${laneIds(catalog).join(", ") || "none"})`,
    };
  }

  const missing = laneMissingEnv(lane, env);
  if (missing.length > 0) {
    return {
      ok: false,
      choice,
      reason:
        `execution lane "${lane.id}" is unavailable: ${missing.join(", ")} ` +
        `${missing.length === 1 ? "is" : "are"} not set in the orchestrator's environment`,
    };
  }

  const { tier, pinnedModel } = resolveAgentModelChoice(
    kind,
    config,
    ticketModel,
    overrides
  );

  const auth: Record<string, string> = {};
  for (const ref of lane.auth) auth[ref.harnessVar] = env[ref.fromEnv]!;

  return {
    ok: true,
    choice,
    lane: {
      id: lane.id,
      label: lane.label,
      adapter: lane.adapter,
      billing: lane.billing,
      auth,
      baseUrl: lane.baseUrl,
      tier,
      model: tier !== null ? lane.models[tier] : pinnedModel,
      caps: lane.caps,
    },
  };
}

/** One lane as the settings screen shows it. Variable *names* only — never a
 * value — because this crosses an API route. */
export interface LaneView {
  id: string;
  label: string;
  adapter: LaneAdapterId;
  billing: LaneBilling;
  baseUrl: string | null;
  models: Readonly<Record<ModelTier, string>>;
  caps: LaneCaps;
  /** The orchestrator variables this lane reads its credentials from. */
  authEnvVars: string[];
  /** Those of them the environment does not supply. */
  missingEnvVars: string[];
  available: boolean;
  /** Whether this is the lane work would run on right now. */
  primary: boolean;
}

/** The whole lane panel: every declared lane, which one is primary, and where
 * that choice came from. */
export interface LaneSettingsView {
  lanes: LaneView[];
  primaryLaneId: string | null;
  source: LaneChoiceSource;
  /** The stored override, or null when the choice falls through. */
  override: string | null;
  /** The variable that supplies (or would supply) the environment default. */
  envVar: string;
  envValue: string | null;
  /** A stored or environment choice naming no declared lane. */
  unknownChoice: string | null;
}

/** The variable the deployment's own lane default comes from. */
export const LANE_ENV_VAR = "AGENT_LANE";

export function describeLanes(
  catalog: LaneCatalog,
  config: AppConfig,
  overrides: SettingsOverrides,
  env: LaneEnv
): LaneSettingsView {
  const choice = choosePrimaryLane({
    catalog,
    override: overrides.primaryLane ?? null,
    envLane: config.agentLane,
    env,
  });

  return {
    primaryLaneId: choice.laneId,
    source: choice.source,
    override: overrides.primaryLane ?? null,
    envVar: LANE_ENV_VAR,
    envValue: config.agentLane,
    unknownChoice: choice.unknownChoice,
    lanes: catalog.lanes.map((lane) => {
      const missingEnvVars = laneMissingEnv(lane, env);
      return {
        id: lane.id,
        label: lane.label,
        adapter: lane.adapter,
        billing: lane.billing,
        baseUrl: lane.baseUrl,
        models: lane.models,
        caps: lane.caps,
        authEnvVars: lane.auth.map((ref) => ref.fromEnv),
        missingEnvVars,
        available: missingEnvVars.length === 0,
        primary: lane.id === choice.laneId,
      };
    }),
  };
}
