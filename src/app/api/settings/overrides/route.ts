import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { getFleetSettings, updateSettingsOverrides } from "@/lib/settings";
import {
  describeModelTierSettings,
  parseSettingsPatch,
  type SettingsOverrides,
} from "@/lib/settings-resolver";
import { getLaneCatalog } from "@/lib/lanes/catalog";
import { laneCatalogContext } from "@/lib/lanes/settings-context";
import { describeLanes, type LaneSettingsView } from "@/lib/lanes/resolve";

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
 */
function laneState(overrides: SettingsOverrides): {
  lanes: LaneSettingsView | null;
  laneError: string | null;
} {
  const catalog = getLaneCatalog();
  if (!catalog.ok) return { lanes: null, laneError: catalog.reason };
  return {
    lanes: describeLanes(catalog.catalog, getConfig(), overrides, process.env),
    laneError: null,
  };
}

function state(overrides: SettingsOverrides, updatedAt: Date | null) {
  return {
    fields: describeModelTierSettings(getConfig(), overrides),
    ...laneState(overrides),
    updatedAt: updatedAt?.toISOString() ?? null,
  };
}

export async function GET() {
  const settings = getFleetSettings();
  return NextResponse.json(state(settings.overrides, settings.updatedAt));
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

  return NextResponse.json(state(settings.overrides, settings.updatedAt));
}
