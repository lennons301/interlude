import { NextResponse } from "next/server";
import { readMoneyGuards } from "@/lib/lanes/money-state";
import { readLaneCrossing } from "@/lib/lanes/overflow-state";
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
 * It also answers the *crossing* (issue #173) — what would happen to an
 * attended session right now — because that is what puts the confirmation in
 * front of the human who is actually sitting there. One endpoint for both:
 * the crossing is judged from this panel's own numbers, and a task screen
 * fetching the question from one route and the press from another would offer
 * a confirmation for a state that had already moved.
 *
 * Everything served here is a number, a lane id or a billing kind. No lane
 * secret is stored in the database or crosses this route, which is the rule a
 * project route once broke.
 */
function state() {
  const settings = getFleetSettings();
  const now = new Date();
  // The same read the sweep and the dashboard make — which lane, at what cap,
  // spent how much, and that lane's own quota row (issue #175) — so the panel
  // cannot report a fleet other than the one being gated.
  const { lane, billing, overagePaying, laneError, cap, spentTodayUsd, state: guards } =
    readMoneyGuards(now, settings);
  // The same pure decision the turn manager routes a pass with and the queue
  // loop declines to start one with — never a second opinion about it.
  // An ordinary chat's crossing: the panel is fleet state, and a generation
  // session's extra requirement (issue #218) is judged at its entry and on its
  // own feed rather than here.
  const crossing = readLaneCrossing("interactive", null, null, now, settings);

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
    /** The effective billing kind — `metered` on an active overage even where
     * the lane declares itself a subscription (issue #173). */
    billing,
    overage: overagePaying,
    hold: guards.hold,
    remainingUsd: guards.remainingUsd,
    // Reported whole rather than narrowed to what the panel renders: the
    // session screen reads `refusal` and `notice`, and the rest is what makes
    // the same GET answer "why is my session held?" headless — which lane it
    // would run on, which one it came off, and whether the wall or an overage
    // is behind it.
    crossing: {
      laneId: crossing.laneId,
      billing: crossing.billing,
      walled: crossing.walled,
      overage: crossing.overage,
      overflowedFrom: crossing.overflowedFrom,
      refusal: crossing.refusal,
      notice: crossing.notice,
      spentUsd: crossing.money?.spentUsd ?? spentTodayUsd,
      capUsd: crossing.money?.capUsd ?? cap.capUsd,
    },
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
