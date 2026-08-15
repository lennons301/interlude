import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { getFleetSettings, setGlobalAutonomyPaused } from "@/lib/settings";

/**
 * The global autonomy kill switch (issue #118). `envMaster` is reported
 * alongside the flag because the two are different things: with
 * `AUTONOMY_ENABLED != true` no sweep runs at all, and a caller showing this
 * state should say that rather than implying the switch is what's holding the
 * fleet. Lifting the switch cannot arm a fleet the env master has disarmed.
 */
function state() {
  const settings = getFleetSettings();
  return {
    globalAutonomyPaused: settings.globalAutonomyPaused,
    updatedAt: settings.updatedAt?.toISOString() ?? null,
    envMaster: getConfig().autonomyEnabled,
  };
}

export async function GET() {
  return NextResponse.json(state());
}

export async function PATCH(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { paused } = (body ?? {}) as { paused?: unknown };
  // Explicit boolean only — same rule as arming a project: a stray truthy
  // string must never decide whether the fleet picks up unattended work.
  if (typeof paused !== "boolean") {
    return NextResponse.json(
      { error: "paused must be a boolean" },
      { status: 400 }
    );
  }

  setGlobalAutonomyPaused(paused);
  // Worth a line in the log either way: this is the one control that silently
  // stops every project's pickup, so "why did the fleet stop?" is answerable.
  console.log(
    `[autonomy] Global kill switch ${paused ? "engaged" : "lifted"} -- ` +
      `${paused ? "no new pickup from" : "pickup resumes at"} the next sweep tick`
  );

  return NextResponse.json(state());
}
