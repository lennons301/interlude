import { NextResponse } from "next/server";
import { readMoneyGuards } from "@/lib/lanes/money-state";
import {
  getFleetSettings,
  setMeteredSpendConfirmed,
  updateSettingsOverrides,
} from "@/lib/settings";
import { parseSettingsPatch } from "@/lib/settings-resolver";

/**
 * The money guards (issue #174) as one screen's worth of state: who pays for
 * the lane in force, how much real money has gone through metered lanes today,
 * the cap that stops it, and whether today's spend has been confirmed.
 *
 * One endpoint rather than two because it backs one panel, and the two
 * controls on it are not independent: raising the cap while the fleet sits
 * held at it should answer with a fleet that is no longer held, and a panel
 * fetching the cap from one route and the hold from another would show that
 * only on the next reload. The cap is still validated by the settings
 * resolver's own allowlist — not a copy of it — so a bad value is refused with
 * a reason and the code ceiling is refused by name.
 *
 * Everything served here is a number, a lane id or a billing kind. No lane
 * secret is stored in the database or crosses this route, which is the rule a
 * project route once broke.
 */
function state() {
  const settings = getFleetSettings();
  // The same read the sweep and the dashboard make, so the panel cannot report
  // a fleet other than the one being gated.
  const { lane, laneError, cap, spentTodayUsd, state: guards } = readMoneyGuards(
    new Date(),
    settings
  );

  return {
    lane:
      lane === null
        ? null
        : { id: lane.id, label: lane.label, billing: lane.billing },
    laneError,
    cap,
    spentTodayUsd,
    confirmedAt: settings.meteredSpendConfirmedAt?.toISOString() ?? null,
    confirmedToday: guards.confirmed,
    metered: guards.metered,
    hold: guards.hold,
    remainingUsd: guards.remainingUsd,
    updatedAt: settings.updatedAt?.toISOString() ?? null,
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

  const { confirmed, capUsd } = (body ?? {}) as {
    confirmed?: unknown;
    capUsd?: unknown;
  };

  if (confirmed === undefined && capUsd === undefined) {
    return NextResponse.json(
      { error: "Nothing to change — send `confirmed` or `capUsd`" },
      { status: 400 }
    );
  }

  if (confirmed !== undefined) {
    // Explicit boolean only — the same rule the kill switch and project arming
    // keep. A stray truthy string must never authorise spending money.
    if (typeof confirmed !== "boolean") {
      return NextResponse.json(
        { error: "confirmed must be a boolean" },
        { status: 400 }
      );
    }
    setMeteredSpendConfirmed(confirmed);
    // Worth a line either way: this press is what lets the fleet spend cash
    // unattended, so "who said yes, and when?" is answerable from the log.
    console.log(
      `[settings] Real-money spend ${confirmed ? "confirmed" : "unconfirmed"} for today`
    );
  }

  if (capUsd !== undefined) {
    if (capUsd !== null && typeof capUsd !== "string") {
      return NextResponse.json(
        { error: "capUsd must be a string amount, or null to clear it" },
        { status: 400 }
      );
    }
    // Through the resolver's own validator, so the ceiling and the
    // never-clamp rule are enforced by the allowlist rather than by a copy of
    // it living here.
    const parsed = parseSettingsPatch({ meteredDailyCapUsd: capUsd });
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    updateSettingsOverrides(parsed.patch);
    console.log(
      `[settings] Real-money daily cap -- ${capUsd ?? "(cleared)"}`
    );
  }

  return NextResponse.json(state());
}
