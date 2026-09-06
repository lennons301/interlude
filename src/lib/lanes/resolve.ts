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
import type { HarnessCapabilities } from "../harness/descriptors";
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
  type LanePrices,
  type TokenPrices,
} from "./lane-config";

/**
 * The tier a priced lane falls back to when nothing else names one — see the
 * note at `laneFallbackTier`. `standard` because it is the lane's own middle
 * answer: a fleet that has configured nothing gets the model the lane
 * considers ordinary, not its most expensive or its weakest.
 */
const PRICED_LANE_DEFAULT_TIER: ModelTier = "standard";

/**
 * What a lane answers with when no tier resolves — the *unset* state, which is
 * what a fresh deployment and a one-press lane switch both leave behind, and
 * not merely the pinned-model escape hatch it looks like.
 *
 * On a first-party lane the answer is null and means what it has always
 * meant: name no model, let the harness resolve its own default. A lane
 * that declares its own model map and its own prices cannot mean that — the
 * identifier the harness would pick belongs to *another* provider's catalogue,
 * so the endpoint either refuses it or quietly serves a first-party model at a
 * price this lane's table does not hold, and the fleet would charge the
 * harness's fiction for it.
 *
 * Exported because the settings screen resolves the same rows the pass does
 * (issue #172), so it must reach the same answer here or a tier row would read
 * "no --model" over a lane that runs a named model.
 */
export function laneFallbackTier(
  lane: Pick<LaneDefinition, "prices">
): ModelTier | null {
  return lane.prices !== null ? PRICED_LANE_DEFAULT_TIER : null;
}

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
      // The dangling choice is carried even when a later layer resolves: an
      // override naming a removed lane is exactly the case where the fleet is
      // not on the lane the operator picked, and that must not be hidden by
      // AGENT_LANE happening to answer.
      return { laneId: value, source, unknownChoice };
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
 * Where the primary-lane choice is read from: the catalog it must name a lane
 * in, the environment default, the stored override, and the environment the
 * credentials live in. One type because both callers — resolving a lane for a
 * pass and describing the lanes for the screen — must answer "which lane is
 * primary?" from exactly the same four things, or the screen would report a
 * lane other than the one a pass would run on.
 */
export interface LaneSettingsInput {
  catalog: LaneCatalog;
  config: AppConfig;
  overrides: SettingsOverrides;
  env: LaneEnv;
}

function primaryLaneInput({
  catalog,
  config,
  overrides,
  env,
}: LaneSettingsInput): PrimaryLaneInput {
  return {
    catalog,
    override: overrides.primaryLane ?? null,
    envLane: config.agentLane,
    env,
  };
}

/**
 * One lane, resolved for one pass: everything an adapter needs to build an
 * exec, and nothing it does not.
 */
/**
 * The one sentence for a lane that cannot run a pass, whatever the cause:
 * variables unset here at resolution, or a credential the provider refused at
 * the end of a turn (issue #220, which ends the pass with this same wording so
 * an operator reading `runs.failureReason` sees one shape for one fact).
 */
export function laneUnavailableReason(laneId: string, why: string): string {
  return `execution lane "${laneId}" is unavailable: ${why}`;
}

/**
 * The `why` for a lane whose named variables the environment does not supply
 * — shared by the resolver refusing a pass and the boot-time availability
 * report (issue #226), so the line an operator reads in the boot log is the
 * line the pass would fail with.
 */
export function missingEnvReason(missing: readonly string[]): string {
  return (
    `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set in the ` +
    "orchestrator's environment"
  );
}

export interface ResolvedLane {
  id: string;
  label: string;
  adapter: LaneAdapterId;
  /** What that adapter can do (issue #219), off the lane definition — carried
   * so a pass's lane answers the same capability questions the screen's does,
   * without a second lookup. Nothing on the pass path branches on it today:
   * the wall ordering reads the refusal's own window, not a capability. */
  capabilities: HarnessCapabilities;
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
  /**
   * What this lane charges for the tier this pass runs at (issue #175), or
   * null to take the harness's own reported cost — see `lane-cost.ts` for why
   * that figure cannot be trusted off a third-party endpoint.
   *
   * Null also covers the pinned-model escape hatch below: a raw model id
   * naming no tier has no priced tier to read, and inventing one would be a
   * guess about money.
   */
  prices: TokenPrices | null;
  /**
   * Whether the lane *definition* declares prices at all — a fact about the
   * lane, where `prices` above is a fact about this pass's tier.
   *
   * They are not the same question, and one caller needs this one. Whether the
   * harness may be handed `--max-budget-usd` turns on "does the CLI price this
   * lane's provider?", which is knowable before any tier resolves; reading the
   * per-tier field there would hand a ceiling in the fleet's currency back to
   * a CLI that misapplies it, in exactly the pinned-model case where nobody is
   * watching the tier.
   */
  declaresPrices: boolean;
  caps: LaneCaps;
}

export type LaneResolution =
  | { ok: true; lane: ResolvedLane; choice: PrimaryLaneChoice }
  | { ok: false; reason: string; choice: PrimaryLaneChoice };

export interface ResolveLaneInput extends LaneSettingsInput {
  kind: AgentPassKind;
  /** A ticket's `model:` directive, already normalised to a tier by the
   * directive parser; null for a pass that carries none. */
  ticketModel: string | null;
  /**
   * Resolve *this* lane rather than the primary — the overflow target an
   * attended session crosses onto when the subscription window is walled
   * (issue #173). Absent (the normal case) resolves the primary.
   *
   * A parameter rather than a second resolver, because everything below it is
   * identical whichever lane is being resolved — the availability report, the
   * tier lookup, the one and only read of a credential — and a copy of it
   * would be a second place for "which variables does this lane need?" to be
   * answered. `choice` still describes the *primary* choice, so a caller can
   * always say which lane the fleet is nominally on.
   */
  laneId?: string | null;
}

/**
 * The lane one pass runs on. The model identifier is the lane's answer for the
 * tier the settings layer chose — the tier is the durable choice a human makes
 * and the lane is what that means here, which is the whole reason issue #166
 * moved the vocabulary to tiers before this ticket existed.
 *
 * One deliberate exception: an environment that pins a raw model id naming no
 * tier (`AGENT_MODEL=<a provider's model id>`) still passes through verbatim. Such a
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
  laneId,
}: ResolveLaneInput): LaneResolution {
  const choice = choosePrimaryLane(primaryLaneInput({ catalog, config, overrides, env }));

  const lane = findLane(catalog, laneId ?? choice.laneId);
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
      reason: laneUnavailableReason(lane.id, missingEnvReason(missing)),
    };
  }

  const chosen = resolveAgentModelChoice(kind, config, ticketModel, overrides);
  const { pinnedModel } = chosen;
  // A priced lane runs a priced model: with nothing naming a tier, and no raw
  // identifier pinned to pass through, the lane's own default answers rather
  // than the harness's. See `laneFallbackTier` for why that is not the same
  // question on every lane.
  const tier = chosen.tier ?? (pinnedModel === null ? laneFallbackTier(lane) : null);

  const auth: Record<string, string> = {};
  for (const ref of lane.auth) auth[ref.harnessVar] = env[ref.fromEnv]!;

  return {
    ok: true,
    choice,
    lane: {
      id: lane.id,
      label: lane.label,
      adapter: lane.adapter,
      capabilities: lane.capabilities,
      billing: lane.billing,
      auth,
      baseUrl: lane.baseUrl,
      tier,
      model: tier !== null ? lane.models[tier] : pinnedModel,
      prices: tier !== null ? (lane.prices?.[tier] ?? null) : null,
      declaresPrices: lane.prices !== null,
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
  /** What the harness behind this lane can do (issue #219): shown on the
   * settings screen, and read by the money guards to know whether the lane's
   * quota row may be read at all. */
  capabilities: HarnessCapabilities;
  billing: LaneBilling;
  baseUrl: string | null;
  models: Readonly<Record<ModelTier, string>>;
  /** The lane's declared per-tier prices (issue #175), or null when it takes
   * the harness's figure. Shown on the settings screen because "what does this
   * lane cost?" is the question the lane exists to answer. */
  prices: LanePrices | null;
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

/**
 * The lane in force, as a view — id, billing kind and declared caps, with no
 * credential in sight. What the money guards (issue #174) read: they need to
 * know who pays and up to how much, and nothing else about the lane. Null when
 * the choice names no declared lane, which is deliberately *not* a money hold
 * (see `evaluateMeteredSpend`): such a fleet spends nothing because every pass
 * refuses to start.
 *
 * Deliberately derived from `describeLanes` rather than resolved separately,
 * so "which lane is primary?" has exactly one answer across the settings
 * screen, the sweep and the dashboard.
 */
export function primaryLaneOf(input: LaneSettingsInput): LaneView | null {
  return primaryLaneInForce(input).lane;
}

/**
 * The lane in force *and* whether it is an operator's explicit choice
 * (issue #176).
 *
 * Cost routing needs the second half, and it is not a new setting: #172
 * already draws the line between an explicit choice — honoured even when it is
 * broken, because routing around an operator's decision is how a fleet spends
 * money nobody authorised — and the *unset* default that walks the file's
 * preference order. Cost routing replaces that walk and only that walk, so an
 * explicit choice **pins the fleet** and turns the ranking off. That is what
 * makes "pinning the fleet to one lane stays expressible in settings" true
 * without a second control to keep in step with the first.
 *
 * Derived from the same `describeLanes` the screen reads, so which lane is
 * primary and whether it is pinned are one answer rather than two.
 */
export function primaryLaneInForce(input: LaneSettingsInput): {
  lane: LaneView | null;
  source: LaneChoiceSource;
  /** The lane cost routing may not move off, or null when the choice falls
   * through and the ranking decides. */
  pinnedLaneId: string | null;
} {
  const view = describeLanes(input);
  const lane = view.lanes.find((candidate) => candidate.primary) ?? null;
  return {
    lane,
    source: view.source,
    // A preference-order answer is a default, not a decision. Anything else is
    // a human's, and is honoured verbatim.
    pinnedLaneId: view.source === "preference" ? null : view.primaryLaneId,
  };
}

export function describeLanes(input: LaneSettingsInput): LaneSettingsView {
  const { catalog, config, env } = input;
  const overrides = input.overrides;
  const choice = choosePrimaryLane(primaryLaneInput(input));

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
        capabilities: lane.capabilities,
        billing: lane.billing,
        baseUrl: lane.baseUrl,
        models: lane.models,
        prices: lane.prices,
        caps: lane.caps,
        authEnvVars: lane.auth.map((ref) => ref.fromEnv),
        missingEnvVars,
        available: missingEnvVars.length === 0,
        primary: lane.id === choice.laneId,
      };
    }),
  };
}
