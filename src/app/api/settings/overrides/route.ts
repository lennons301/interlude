import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { getFleetSettings, updateSettingsOverrides } from "@/lib/settings";
import {
  describeMinLaneSettings,
  describeModelTierSettings,
  parseSettingsPatch,
  resolveQuotaThreshold,
  resolveResumeBound,
  type SettingsOverrides,
  type TierModelIds,
} from "@/lib/settings-resolver";
import { AGENT_PASS_KINDS } from "@/lib/config";
import { readLaneSelection } from "@/lib/lanes/overflow-state";
import { getFleetSettings as readFleetSettings } from "@/lib/settings";
import type { ModelTier } from "@/lib/model-tiers";
import { getLaneCatalog } from "@/lib/lanes/catalog";
import { laneCatalogContext } from "@/lib/lanes/settings-context";
import {
  describeLanes,
  laneFallbackTier,
  type LaneSettingsView,
} from "@/lib/lanes/resolve";
import { readHarnessImageStates } from "@/lib/harness/image-state";

/**
 * The UI-editable settings layer (issues #166, #172): env config with a stored
 * override on top, each field reported with the value in force and where that
 * value came from.
 *
 * Reads and writes go through the same resolvers a pass is handed, so the
 * screen cannot show one thing while the fleet runs another. The route
 * validates every value against the resolver's allowlist rather than a copy of
 * it — a disallowed value is rejected with a message, never clamped, and a
 * safety ceiling is refused by name.
 *
 * The lane section carries variable **names** only, never values. That is not
 * incidental: a project API route has previously leaked a stored token in
 * cleartext, so nothing on this path may serve a credential, and no lane secret
 * is stored in the database to be served in the first place.
 *
 * Beside each lane the screen shows its harness, whether that harness's image
 * is built and whether its credentials are present (issue #219). The image
 * state is a bounded Docker probe made once per adapter the file names — the
 * one outbound call in this route, and one that cannot hold the response
 * hostage: a daemon that does not answer reads as *unknown*.
 */
function laneState(overrides: SettingsOverrides): {
  lanes: LaneSettingsView | null;
  laneError: string | null;
  /** The primary lane's tier map — what the model-tier rows must be resolved
   * against, so the screen names the model a pass would actually run. Null
   * with no primary lane to read (an unusable lane file): the rows then name
   * the tier alone rather than a model off some other lane's map. */
  tierModels: TierModelIds | null;
  /** And what that lane answers an *unset* row with (issue #175): a priced
   * lane runs its own default tier rather than no `--model` at all. */
  fallbackTier: ModelTier | null;
} {
  const catalog = getLaneCatalog();
  if (!catalog.ok) {
    // No catalog means no pass can start at all, which the lane panel says in
    // as many words; the tier rows keep their tiers and name no model beside
    // them, since there is no lane whose map could say what a tier means.
    return {
      lanes: null,
      laneError: catalog.reason,
      tierModels: null,
      fallbackTier: null,
    };
  }
  const lanes = describeLanes({
    catalog: catalog.catalog,
    config: getConfig(),
    overrides,
    env: process.env,
  });
  const primary = lanes.lanes.find((lane) => lane.primary);
  return {
    lanes,
    laneError: null,
    tierModels: primary?.models ?? null,
    fallbackTier: primary ? laneFallbackTier(primary) : null,
  };
}

/**
 * What cost routing would pick for each pass kind right now (issue #176) —
 * the lane, and what it charges per million tokens of a representative pass.
 *
 * Read through the same `selectLane` a pass is routed by, for the #148 reason:
 * the row that says "an implement pass will run on X" has to be the answer the
 * pass gets, or the minimum-lane control above it would be adjusting something
 * the screen cannot show.
 *
 * `repair` is deliberately absent: it reads the implement floor and would
 * render as a duplicate row of it.
 */
function routingState(now: Date) {
  const settings = readFleetSettings();
  return AGENT_PASS_KINDS.filter((kind) => kind !== "repair").map((kind) => {
    const selection = readLaneSelection(kind, null, now, settings);
    // The lane the pass would run on — the ranking's pick, or the lane in
    // force it falls back to, which is what the crossing does. Reporting "no
    // lane" for the fall-back would leave this row claiming a pass would be
    // refused while it ran perfectly well, which is the disagreement the
    // shared ranking exists to prevent.
    const lane = selection.chosen ?? selection.inForce;
    return {
      kind,
      laneId: lane?.id ?? null,
      label: lane?.label ?? null,
      billing: lane?.effectiveBilling ?? null,
      rateUsdPerMTok: lane?.rateUsdPerMTok ?? null,
      /** Whether the ranking chose it, or it is the fall-back — where the pass
       * runs, but only because nothing qualified. */
      chosen: selection.chosen !== null,
      /** Every lane it passed over and why — the cost case, in order. */
      passedOver: selection.candidates
        .filter((candidate) => candidate.ineligible !== null)
        .map((candidate) => ({
          id: candidate.id,
          reason: candidate.ineligible,
          rateUsdPerMTok: candidate.rateUsdPerMTok,
        })),
    };
  });
}

async function state(overrides: SettingsOverrides, updatedAt: Date | null) {
  const { tierModels, fallbackTier, lanes, laneError } = laneState(overrides);
  return {
    fields: describeModelTierSettings(
      getConfig(),
      overrides,
      tierModels,
      fallbackTier
    ),
    lanes,
    laneError,
    // Each harness the file names, with whether its image is built (issue
    // #219) — one probe per adapter, not per lane, since lanes on one harness
    // share one image; the panel joins on the lane's adapter id.
    harnesses: await readHarnessImageStates(
      lanes?.lanes.map((lane) => lane.adapter) ?? []
    ),
    // The lane floors (issue #176), beside the lane panel they restrict: one
    // per pass kind, in the same order the tier rows are, so the two read as
    // one table.
    minLanes: describeMinLaneSettings(getConfig(), overrides),
    /** What cost routing would pick for each kind right now. */
    routing: routingState(new Date()),
    // The quota admission threshold (issue #171) — its own view model beside
    // the lane's, for the same reason: it shares the allowlist but not the
    // model-tier field shape, since asking a percentage what tier is in force
    // is not a meaningful question.
    quota: resolveQuotaThreshold(getConfig(), overrides),
    // The resume bound (issue #169) is the same shape of answer as the
    // threshold above, and the other half of what "quota" means on the screen.
    resumeBound: resolveResumeBound(getConfig(), overrides),
    updatedAt: updatedAt?.toISOString() ?? null,
  };
}

export async function GET() {
  const settings = getFleetSettings();
  return NextResponse.json(await state(settings.overrides, settings.updatedAt));
}

export async function PATCH(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // The lane vocabulary is a runtime file, so it is handed to the validator
  // rather than compiled into it — which is what lets an unknown lane id be
  // refused by name instead of stored and quietly ignored at the next pass.
  const parsed = parseSettingsPatch(body, laneCatalogContext());
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const settings = updateSettingsOverrides(parsed.patch);
  // Worth a line either way: these values decide what every subsequent pass
  // runs on, and "why is the fleet suddenly on haiku?" should be answerable
  // from the log without reading the row.
  console.log(
    `[settings] Overrides changed -- ${Object.entries(parsed.patch)
      .map(([key, value]) => `${key}=${value ?? "(cleared)"}`)
      .join(", ")}`
  );

  return NextResponse.json(await state(settings.overrides, settings.updatedAt));
}
