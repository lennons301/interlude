import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../config";
import { MAX_METERED_DAILY_CAP_USD } from "../../orchestrator/autonomy/budgets";
import { parseSettingsPatch, type SettingsOverrides } from "../../settings-resolver";
import { evaluateMeteredSpend, resolveMeteredCap, sameLocalDay } from "../money";

/**
 * The money guards (issue #174), tested as the pure policy they are: no lane
 * file, no database, no clock. Every rule below is one the reducer and the
 * dashboard both depend on, which is why they read it from here rather than
 * each deciding it.
 */

/** A config carrying only the field the cap resolver reads. */
function cfg(meteredDailyCapUsd = 20): AppConfig {
  return { meteredDailyCapUsd } as AppConfig;
}

const NONE: SettingsOverrides = {};

describe("the real-money daily cap in force", () => {
  it("falls through to the environment default when unset", () => {
    const cap = resolveMeteredCap(cfg(20), NONE, null);

    expect(cap.capUsd).toBe(20);
    expect(cap.source).toBe("environment");
    expect(cap.override).toBeNull();
    expect(cap.envVar).toBe("METERED_DAILY_CAP_USD");
  });

  it("takes a stored override, and says so", () => {
    const cap = resolveMeteredCap(cfg(20), { meteredDailyCapUsd: "35" }, null);

    expect(cap.capUsd).toBe(35);
    expect(cap.source).toBe("override");
    expect(cap.override).toBe("35");
    // Clearing it goes back here — the number the panel offers as the fallback.
    expect(cap.envUsd).toBe(20);
  });

  it("lets a lane's own declared cap bind the operator's dial down", () => {
    // lanes.yaml is reviewed, version-controlled configuration; a settings
    // press is not the place to overrule "never more than $20/day here".
    const cap = resolveMeteredCap(cfg(50), { meteredDailyCapUsd: "50" }, 20);

    expect(cap.capUsd).toBe(20);
    expect(cap.boundBy).toBe("lane");
    expect(cap.settingUsd).toBe(50);
    expect(cap.laneUsd).toBe(20);
  });

  it("does not let a lane's declared cap widen a lower dial", () => {
    const cap = resolveMeteredCap(cfg(5), NONE, 20);

    expect(cap.capUsd).toBe(5);
    expect(cap.boundBy).toBe("settings");
  });

  it("ignores a stored value the field's own vocabulary would refuse", () => {
    // The row is JSON an older build wrote, and the ceiling may have been
    // lowered since. Falling through beats reaching the cap unvalidated.
    const cap = resolveMeteredCap(
      cfg(20),
      { meteredDailyCapUsd: String(MAX_METERED_DAILY_CAP_USD + 1) },
      null
    );

    expect(cap.capUsd).toBe(20);
    expect(cap.source).toBe("environment");
  });
});

describe("the settings field behind it", () => {
  it("accepts a positive amount up to the ceiling and rejects the rest", () => {
    expect(parseSettingsPatch({ meteredDailyCapUsd: "12.5" })).toEqual({
      ok: true,
      patch: { meteredDailyCapUsd: "12.5" },
    });
    // Refused with a reason, never clamped: "I asked for X" must not become
    // "the fleet quietly did Y" on the one number that authorises cash.
    for (const bad of ["0", "-5", "abc", String(MAX_METERED_DAILY_CAP_USD + 1)]) {
      const parsed = parseSettingsPatch({ meteredDailyCapUsd: bad });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error).toContain(`up to $${MAX_METERED_DAILY_CAP_USD}`);
      }
    }
  });

  it("refuses the ceiling itself by name", () => {
    const parsed = parseSettingsPatch({ maxMeteredDailyCapUsd: "1000" });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("safety ceiling");
  });
});

describe("the confirm-once-per-day gate", () => {
  const NOON = new Date(2026, 7, 1, 12, 0, 0);

  it("counts a confirmation made earlier the same local day", () => {
    expect(sameLocalDay(new Date(2026, 7, 1, 0, 0, 1), NOON)).toBe(true);
    expect(sameLocalDay(new Date(2026, 7, 1, 23, 59, 59), NOON)).toBe(true);
  });

  it("does not count one made the day before", () => {
    expect(sameLocalDay(new Date(2026, 6, 31, 23, 59, 59), NOON)).toBe(false);
  });

  it("holds unconfirmed metered work and clears once confirmed", () => {
    const unconfirmed = evaluateMeteredSpend({
      billing: "metered",
      spentUsd: 0,
      capUsd: 20,
      confirmedAt: null,
      now: NOON,
    });
    expect(unconfirmed.hold).toBe("unconfirmed");

    const confirmed = evaluateMeteredSpend({
      billing: "metered",
      spentUsd: 0,
      capUsd: 20,
      confirmedAt: new Date(2026, 7, 1, 9, 0, 0),
      now: NOON,
    });
    expect(confirmed.hold).toBeNull();
    expect(confirmed.confirmed).toBe(true);
  });
});

describe("what the guards hold", () => {
  const NOON = new Date(2026, 7, 1, 12, 0, 0);
  const confirmed = new Date(2026, 7, 1, 9, 0, 0);

  it("holds nothing on a subscription lane, whatever has been spent", () => {
    const state = evaluateMeteredSpend({
      billing: "subscription",
      spentUsd: 999,
      capUsd: 20,
      confirmedAt: null,
      now: NOON,
    });

    expect(state.metered).toBe(false);
    expect(state.hold).toBeNull();
  });

  it("holds nothing when no lane resolves", () => {
    const state = evaluateMeteredSpend({
      billing: null,
      spentUsd: 0,
      capUsd: 20,
      confirmedAt: null,
      now: NOON,
    });

    expect(state.hold).toBeNull();
  });

  it("holds at the cap, and lets the cap outrank the confirmation", () => {
    const capped = evaluateMeteredSpend({
      billing: "metered",
      spentUsd: 20,
      capUsd: 20,
      confirmedAt: confirmed,
      now: NOON,
    });
    expect(capped.hold).toBe("cap-reached");
    expect(capped.remainingUsd).toBe(0);

    const cappedUnconfirmed = evaluateMeteredSpend({
      billing: "metered",
      spentUsd: 25,
      capUsd: 20,
      confirmedAt: null,
      now: NOON,
    });
    expect(cappedUnconfirmed.hold).toBe("cap-reached");
    // An overspent day reads as nothing left, not as a debt.
    expect(cappedUnconfirmed.remainingUsd).toBe(0);
  });

  it("runs freely inside a confirmed cap", () => {
    const state = evaluateMeteredSpend({
      billing: "metered",
      spentUsd: 12,
      capUsd: 20,
      confirmedAt: confirmed,
      now: NOON,
    });

    expect(state.hold).toBeNull();
    expect(state.remainingUsd).toBe(8);
  });
});
