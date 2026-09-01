import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { getFleetSettings, updateSettingsOverrides } from "@/lib/settings";
import {
  describeSettings,
  parseSettingsPatch,
  type SettingsOverrides,
} from "@/lib/settings-resolver";

/**
 * The UI-editable settings layer (issue #166): env config with a stored
 * override on top, each field reported with the value in force and where that
 * value came from.
 *
 * Reads and writes go through the same `describeSettings` the resolver hands a
 * pass, so the screen cannot show one thing while the fleet runs another. The
 * route validates every value against the resolver's allowlist rather than a
 * copy of it — a disallowed value is rejected with a message, never clamped,
 * and a safety ceiling is refused by name.
 */
function state(overrides: SettingsOverrides, updatedAt: Date | null) {
  return {
    fields: describeSettings(getConfig(), overrides),
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

  const parsed = parseSettingsPatch(body);
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
