import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../config";
import type { QuotaObservation } from "../../quota/rate-limit-event";
import type { SettingsOverrides } from "../../settings-resolver";
import { HARNESS_ADAPTER_DESCRIPTORS } from "../../harness/descriptors";
import { FAKE_NO_SKILLS_HARNESS_ID, fakeNoSkillsDescriptor } from "@/test/fake-harness";
import { parseLaneConfig, type LaneCatalog } from "../lane-config";
import {
  decideLaneCrossing,
  effectiveBilling,
  laneIsWalled,
  overageIsThePayer,
  payerChanged,
  overagePaysNow,
  type CrossingLane,
  type LaneCrossingInput,
} from "../overflow";

/**
 * The crossing (issue #173), tested as the pure policy it is: no lane file, no
 * database, no clock and no provider. Every rule here is one that three
 * surfaces depend on — the turn manager routing a pass, the queue loop
 * declining to start one, and the UI asking the human to confirm — which is
 * why they read it from this one function.
 */

const LANES = `
primary:
  - subscription
  - direct-api
lanes:
  - id: subscription
    label: Claude subscription
    adapter: claude-code
    billing: subscription
    auth:
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_CODE_OAUTH_TOKEN
    models:
      heavy: opus
      standard: sonnet
      light: haiku
  - id: direct-api
    label: Anthropic API
    adapter: claude-code
    billing: metered
    auth:
      ANTHROPIC_API_KEY: ANTHROPIC_API_KEY
    models:
      heavy: opus
      standard: sonnet
      light: haiku
    caps:
      daily_budget_usd: 20
  - id: openrouter
    label: OpenRouter
    adapter: claude-code
    billing: metered
    auth:
      ANTHROPIC_AUTH_TOKEN: OPENROUTER_API_KEY
    base_url: https://openrouter.ai/api
    models:
      heavy: anthropic/claude-opus-4.1
      standard: anthropic/claude-sonnet-4.5
      light: anthropic/claude-haiku-4.5
    caps:
      daily_budget_usd: 20
`;

const catalog: LaneCatalog = (() => {
  const parsed = parseLaneConfig(LANES);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.catalog;
})();

const NOW = new Date("2026-09-02T10:00:00");
const RESETS = new Date("2026-09-02T14:05:00");

const SUBSCRIPTION: CrossingLane = {
  id: "subscription",
  label: "Claude subscription",
  billing: "subscription",
  caps: { dailyBudgetUsd: null },
};

const METERED_PRIMARY: CrossingLane = {
  id: "direct-api",
  label: "Anthropic API",
  billing: "metered",
  caps: { dailyBudgetUsd: 20 },
};

/** Both metered lanes' credentials present, so availability is never the thing
 * under test unless a case takes one away. */
const FULL_ENV = {
  CLAUDE_CODE_OAUTH_TOKEN: "oauth",
  ANTHROPIC_API_KEY: "sk-ant",
  OPENROUTER_API_KEY: "sk-or",
};

function observation(fields: Partial<QuotaObservation> = {}): QuotaObservation {
  return {
    status: "allowed",
    rateLimitType: "five_hour",
    utilization: 12,
    resetsAt: RESETS,
    overageStatus: null,
    overageResetsAt: null,
    isUsingOverage: null,
    overageInUse: null,
    observedAt: NOW,
    ...fields,
  };
}

/** A rejection with a stated reset — the wall #168 pauses an autonomous run
 * on, and the one this ticket overflows an attended session off. */
const WALL = observation({ status: "rejected", utilization: null });

function crossing(over: Partial<LaneCrossingInput> = {}) {
  return decideLaneCrossing({
    kind: "interactive",
    primary: SUBSCRIPTION,
    catalog,
    env: FULL_ENV,
    observation: WALL,
    config: { meteredDailyCapUsd: 20 } as AppConfig,
    overrides: {} as SettingsOverrides,
    spentTodayUsd: 0,
    confirmedAt: NOW,
    now: NOW,
    ...over,
  });
}

describe("an active overage means the account is already paying cash", () => {
  it("counts a request that drew on overage", () => {
    expect(overagePaysNow(observation({ isUsingOverage: true }), NOW)).toBe(true);
  });

  it("counts a refused window whose overage window is still serving", () => {
    // `scripts/rate-limit-stub.mjs --scenario overage-active`: the wall is up,
    // the request succeeded anyway, and the card paid for it.
    const active = observation({
      status: "rejected",
      overageStatus: "allowed",
      overageInUse: true,
    });
    expect(overagePaysNow(active, NOW)).toBe(true);
  });

  it("does not count overage merely being available on a healthy account", () => {
    // The real captured event from a working account carries exactly this:
    // billing is configured, nothing is drawing on it. Reading it as cash
    // would hold the fleet for a confirmation nobody owed.
    const healthy = observation({
      status: "allowed",
      rateLimitType: "overage",
      overageStatus: "allowed",
      isUsingOverage: false,
      overageInUse: true,
    });
    expect(overagePaysNow(healthy, NOW)).toBe(false);
  });

  it("decides nothing from an overage status this build has never heard", () => {
    // #171's rule, inherited: only a member this build understands may decide
    // anything. Read as "serving" it would suppress the wall, and the session
    // would stay on the walled lane instead of crossing off it.
    const unheard = observation({
      status: "rejected",
      overageStatus: "throttled_pending_review",
    });

    expect(overagePaysNow(unheard, NOW)).toBe(false);
    expect(laneIsWalled(SUBSCRIPTION, unheard, NOW)).toBe(true);
    // ...so the attended session crosses, and the guards hold the cash rather
    // than the telemetry holding the work.
    const decision = crossing({ observation: unheard });
    expect(decision.laneId).toBe("direct-api");
  });

  it("counts an overage window that is merely warning, not refusing", () => {
    const warning = observation({
      status: "rejected",
      overageStatus: "allowed_warning",
    });

    expect(overagePaysNow(warning, NOW)).toBe(true);
  });

  it("does not count a wall whose overage is exhausted too", () => {
    const exhausted = observation({
      status: "rejected",
      overageStatus: "rejected",
    });
    expect(overagePaysNow(exhausted, NOW)).toBe(false);
    // ...and that is a real wall, so an attended session overflows off it.
    expect(laneIsWalled(SUBSCRIPTION, exhausted, NOW)).toBe(true);
  });

  it("decides nothing from telemetry that no longer describes the account", () => {
    const past = new Date(RESETS.getTime() + 1000);
    expect(overagePaysNow(observation({ isUsingOverage: true }), past)).toBe(false);
    expect(laneIsWalled(SUBSCRIPTION, WALL, past)).toBe(false);
  });

  it("is not a wall — the pass runs on the same lane, the card just pays", () => {
    const active = observation({ status: "rejected", overageStatus: "allowed" });
    expect(laneIsWalled(SUBSCRIPTION, active, NOW)).toBe(false);
  });
});

describe("what counts as walled", () => {
  it("needs a rejection: a warning is not a wall", () => {
    const warning = observation({ status: "allowed_warning", utilization: 97 });
    expect(laneIsWalled(SUBSCRIPTION, warning, NOW)).toBe(false);
  });

  it("is never true of a metered lane, which reports no quota at all", () => {
    expect(laneIsWalled(METERED_PRIMARY, WALL, NOW)).toBe(false);
  });

  it("needs an observation: silence is not a wall", () => {
    expect(laneIsWalled(SUBSCRIPTION, null, NOW)).toBe(false);
  });
});

describe("autonomous passes are routed too, but never held (issue #176)", () => {
  it.each(["implement", "review", "triage", "repair"] as const)(
    "moves a %s pass off the walled lane once the day's cash is confirmed",
    (kind) => {
      // #173 left autonomous work on the walled lane to be paused by #168.
      // #176 routes it, because parking for five hours beside a lane that can
      // run the work is worse than paying for it — bounded by the very guards
      // below, never exempted from them.
      const decision = crossing({ kind });

      expect(decision.laneId).toBe("direct-api");
      expect(decision.overflowedFrom).toBe("subscription");
      expect(decision.billing).toBe("metered");
      expect(decision.refusal).toBeNull();
      // The wall is still reported — it is a fact about the fleet, not a
      // decision about this pass.
      expect(decision.walled).toBe(true);
    }
  );

  it.each(["implement", "review", "triage", "repair"] as const)(
    "leaves a %s pass on the walled lane while the day's cash is unconfirmed",
    (kind) => {
      // The #168 path, preserved exactly: with no lane the fleet is permitted
      // to spend on, the pass runs where it was sent, is refused in ~2s, and
      // its run parks on the window's clock. An autonomous pass is never
      // *held* here — #174's guards hold pickup, not a pass under way — so
      // there is no refusal to answer either.
      const decision = crossing({ kind, confirmedAt: null });

      expect(decision.laneId).toBe("subscription");
      expect(decision.overflowedFrom).toBeNull();
      expect(decision.billing).toBe("subscription");
      expect(decision.refusal).toBeNull();
      expect(decision.walled).toBe(true);
    }
  );

  it("leaves a walled autonomous pass in place once the cash cap is spent", () => {
    const decision = crossing({ kind: "implement", spentTodayUsd: 20 });

    expect(decision.laneId).toBe("subscription");
    expect(decision.refusal).toBeNull();
  });

  it("still books an autonomous pass's overage spend as the cash it is", () => {
    const decision = crossing({
      kind: "implement",
      observation: observation({ isUsingOverage: true }),
    });

    expect(decision.billing).toBe("metered");
    // Never refused: #174's guards hold pickup, not a pass already running.
    expect(decision.refusal).toBeNull();
  });
});

describe("interactive work overflows to a metered lane", () => {
  it("routes to the first available metered lane in preference order", () => {
    const decision = crossing();

    expect(decision.laneId).toBe("direct-api");
    expect(decision.overflowedFrom).toBe("subscription");
    expect(decision.billing).toBe("metered");
    expect(decision.refusal).toBeNull();
    expect(decision.notice).toContain("Anthropic API");
    // The cause is named before the consequence, with the window's own clock.
    expect(decision.notice).toContain("resets 14:05");
  });

  it("falls past a metered lane whose credential is missing", () => {
    const decision = crossing({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth", OPENROUTER_API_KEY: "sk-or" },
    });

    expect(decision.laneId).toBe("openrouter");
    expect(decision.overflowedFrom).toBe("subscription");
  });

  it("stays on the subscription lane while the window is fine", () => {
    const decision = crossing({ observation: observation() });

    expect(decision.laneId).toBe("subscription");
    expect(decision.billing).toBe("subscription");
    expect(decision.money).toBeNull();
    expect(decision.notice).toBeNull();
  });

  it("refuses, naming what is missing, when no metered lane is available", () => {
    const decision = crossing({ env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth" } });

    expect(decision.refusal?.reason).toBe("no-metered-lane");
    expect(decision.refusal?.message).toContain("ANTHROPIC_API_KEY");
    expect(decision.refusal?.message).toContain("OPENROUTER_API_KEY");
    expect(decision.laneId).toBe("subscription");
  });

  it("does not route off a lane that is merely unavailable", () => {
    // A missing credential is #172's report, not a wall, and cost routing may
    // not paper over a misconfiguration by spending money at another provider
    // (issue #176) — the pass stays where it was sent and dies naming the
    // variable.
    const decision = crossing({
      observation: null,
      env: { ANTHROPIC_API_KEY: "sk-ant" },
    });

    expect(decision.overflowedFrom).toBeNull();
    expect(decision.laneId).toBe("subscription");
    expect(decision.refusal).toBeNull();
  });
});

describe("the at-the-keyboard confirmation", () => {
  it("asks for one before the first real money of the day", () => {
    const decision = crossing({ confirmedAt: null });

    expect(decision.refusal?.reason).toBe("unconfirmed");
    expect(decision.refusal?.message).toContain("$0.00 of $20.00");
    expect(decision.refusal?.message).toContain("Confirm real-money spend");
    // The lane is still named, so the UI can say what it would spend on.
    expect(decision.laneId).toBe("direct-api");
  });

  it("treats yesterday's confirmation as no confirmation", () => {
    const decision = crossing({
      confirmedAt: new Date("2026-09-01T23:59:00"),
    });

    expect(decision.refusal?.reason).toBe("unconfirmed");
  });

  it("lets the rest of the day's overflow through once confirmed", () => {
    const decision = crossing({
      confirmedAt: new Date("2026-09-02T09:00:00"),
      spentTodayUsd: 4.5,
    });

    expect(decision.refusal).toBeNull();
    expect(decision.laneId).toBe("direct-api");
    expect(decision.notice).toContain("$4.50 of $20.00");
  });

  it("asks on a metered primary too — the confirmation is per day, not per overflow", () => {
    // #174 deliberately left interactive dispatch ungated; the attended
    // confirmation is this ticket's, and it keys off the billing kind rather
    // than off having overflowed, exactly as that ticket's guards do.
    const decision = crossing({
      primary: METERED_PRIMARY,
      // Pinned, which is one of only two ways a metered lane is primary — the
      // other being a subscription credential the deployment does not have,
      // and in both cost routing leaves the choice alone (issue #176).
      pinnedLaneId: "direct-api",
      observation: null,
      confirmedAt: null,
    });

    expect(decision.refusal?.reason).toBe("unconfirmed");
    expect(decision.overflowedFrom).toBeNull();
    expect(decision.billing).toBe("metered");
  });

  it("asks before subscription work that an overage has started billing", () => {
    const decision = crossing({
      observation: observation({ isUsingOverage: true }),
      confirmedAt: null,
    });

    expect(decision.refusal?.reason).toBe("unconfirmed");
    expect(decision.refusal?.message).toContain("overage");
    // No overflow: the lane in force is already the paid one.
    expect(decision.laneId).toBe("subscription");
    expect(decision.overflowedFrom).toBeNull();
    expect(decision.billing).toBe("metered");
  });
});

describe("falling back to the lane in force never skips the money guards", () => {
  // The hole cost routing opened and closed: when the ranking picks nothing,
  // the pass runs where it was sent — and if *that* lane bills per token, its
  // spend still answers to #174's cap and confirm-once press. Before this it
  // fell through with `money: null` and no refusal, which was a way onto a
  // paid lane the fleet had not been permitted to spend on.
  function onMeteredPrimary(over: Partial<LaneCrossingInput> = {}) {
    return crossing({
      primary: METERED_PRIMARY,
      pinnedLaneId: "direct-api",
      observation: null,
      ...over,
    });
  }

  it("asks for the day's confirmation even when nothing else was eligible", () => {
    const decision = onMeteredPrimary({ confirmedAt: null });

    expect(decision.laneId).toBe("direct-api");
    expect(decision.billing).toBe("metered");
    expect(decision.refusal?.reason).toBe("unconfirmed");
    expect(decision.money?.hold).toBe("unconfirmed");
  });

  it("reports the cap even when nothing else was eligible", () => {
    const decision = onMeteredPrimary({ spentTodayUsd: 99 });

    expect(decision.refusal?.reason).toBe("cap-reached");
    expect(decision.money?.capReached).toBe(true);
  });

  it("holds a metered lane the pass kind's own floor put out of reach", () => {
    // The floor never excludes the lane in force — it bounds where routing may
    // *send* a pass — so the session runs there, and running there costs money,
    // so the guards decide. Excluding it instead would have meant either
    // silently running below the floor or refusing a pass with nowhere to go.
    const decision = crossing({
      primary: METERED_PRIMARY,
      observation: null,
      minLaneId: "openrouter",
      env: { ANTHROPIC_API_KEY: "sk-ant" },
      confirmedAt: null,
    });

    expect(decision.laneId).toBe("direct-api");
    expect(decision.refusal?.reason).toBe("unconfirmed");
  });

  it("still runs an autonomous pass there, booked as the cash it is", () => {
    // #174's guards hold *pickup*, never a pass already under way, so an
    // autonomous pass is routed rather than held — but its dollars are booked
    // to a metered lane and its money state is reported rather than dropped.
    const decision = onMeteredPrimary({ kind: "implement", confirmedAt: null });

    expect(decision.refusal).toBeNull();
    expect(decision.billing).toBe("metered");
    expect(decision.money?.hold).toBe("unconfirmed");
  });
});

describe("the cap", () => {
  it("tells an attended session it is capped rather than overflowing", () => {
    const decision = crossing({ spentTodayUsd: 20 });

    expect(decision.refusal?.reason).toBe("cap-reached");
    expect(decision.refusal?.message).toContain("$20.00");
    expect(decision.money?.remainingUsd).toBe(0);
  });

  it("outranks the confirmation, because confirming would start nothing", () => {
    const decision = crossing({ spentTodayUsd: 25, confirmedAt: null });

    expect(decision.refusal?.reason).toBe("cap-reached");
  });

  it("is bound down by the overflow lane's own declared cap", () => {
    const decision = crossing({
      config: { meteredDailyCapUsd: 50 } as AppConfig,
      spentTodayUsd: 20,
    });

    // The dial says $50, lanes.yaml says $20 on this lane, the lower wins.
    expect(decision.money?.capUsd).toBe(20);
    expect(decision.refusal?.reason).toBe("cap-reached");
  });

  it("leaves subscription-lane interactive work exempt", () => {
    const decision = crossing({
      observation: observation(),
      spentTodayUsd: 500,
      confirmedAt: null,
    });

    expect(decision.refusal).toBeNull();
    expect(decision.billing).toBe("subscription");
  });
});

describe("the pieces the callers share", () => {
  // Which lane a crossing lands on is `lane-selection.ts`'s ranking since
  // issue #176 — ordering, exclusion and the empty-catalog case are tested
  // there, against the cost rules that decide them.

  it("makes cash of a metered lane or an overage, and nothing else", () => {
    expect(effectiveBilling("subscription", false)).toBe("subscription");
    expect(effectiveBilling("subscription", true)).toBe("metered");
    expect(effectiveBilling("metered", false)).toBe("metered");
  });

  it("calls an overage the payer only on a lane that bills nothing itself", () => {
    // The condition three surfaces write a sentence from: a metered lane
    // observed while an overage is active still bills per token on its own
    // account, and describing it as an overage would be the same confusion in
    // the other direction.
    expect(overageIsThePayer("subscription", true)).toBe(true);
    expect(overageIsThePayer("metered", true)).toBe(false);
    expect(overageIsThePayer("subscription", false)).toBe(false);
    expect(overageIsThePayer(null, true)).toBe(false);
  });

  it("decides nothing at all when no lane resolves", () => {
    const decision = crossing({ primary: null });

    expect(decision.laneId).toBeNull();
    expect(decision.billing).toBeNull();
    expect(decision.refusal).toBeNull();
  });

  it("calls a crossing news when the payer changes, and only then", () => {
    // A session driven through a walled afternoon must be told once, not once
    // a turn: the sentence quotes the day's running spend, so an exact-text
    // dedup alone would post again every turn with a few cents more on it.
    const onto = { laneId: "direct-api", billing: "metered" as const };

    expect(payerChanged({ lane: null, laneBilling: null }, onto)).toBe(true);
    expect(
      payerChanged({ lane: "subscription", laneBilling: "subscription" }, onto)
    ).toBe(true);
    expect(
      payerChanged({ lane: "direct-api", laneBilling: "metered" }, onto)
    ).toBe(false);
    // The lane held still while an overage started paying for it — a change of
    // payer without a change of lane, which is exactly the case a lane-only
    // comparison would miss.
    expect(
      payerChanged(
        { lane: "subscription", laneBilling: "subscription" },
        { laneId: "subscription", billing: "metered" }
      )
    ).toBe(true);
  });
});

describe("a generation session is refused, never started as chat, where no lane can invoke its skill (issue #218)", () => {
  // The shipped Claude lanes beside a lane on a harness that does not expand a
  // user-invoked skill (the shared no-skills fake), made primary — the
  // configuration in which a skill session used to fall back onto the lane in
  // force and become freeform chat.
  const NO_SKILLS = FAKE_NO_SKILLS_HARNESS_ID;
  const skillsCatalog: LaneCatalog = (() => {
    const parsed = parseLaneConfig(
      `
primary:
  - other-sub
  - subscription
lanes:
  - id: other-sub
    label: Other harness
    adapter: ${NO_SKILLS}
    billing: subscription
    auth:
      OTHER_TOKEN: OTHER_TOKEN
    models:
      heavy: other-big
      standard: other-mid
      light: other-small
  - id: subscription
    label: Claude subscription
    adapter: claude-code
    billing: subscription
    auth:
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_CODE_OAUTH_TOKEN
    models:
      heavy: opus
      standard: sonnet
      light: haiku
  - id: direct-api
    label: Anthropic API
    adapter: claude-code
    billing: metered
    auth:
      ANTHROPIC_API_KEY: ANTHROPIC_API_KEY
    models:
      heavy: opus
      standard: sonnet
      light: haiku
    caps:
      daily_budget_usd: 20
  - id: other-api
    label: Other harness (metered)
    adapter: ${NO_SKILLS}
    billing: metered
    auth:
      OTHER_API_KEY: OTHER_API_KEY
    models:
      heavy: other-big
      standard: other-mid
      light: other-small
    prices:
      heavy: { input: 1.0, output: 4.0, cache_read: 0.1 }
      standard: { input: 0.1, output: 0.4, cache_read: 0.01 }
      light: { input: 0.05, output: 0.2, cache_read: 0.005 }
    caps:
      daily_budget_usd: 20
`,
      [...HARNESS_ADAPTER_DESCRIPTORS, fakeNoSkillsDescriptor]
    );
    if (!parsed.ok) throw new Error(parsed.reason);
    return parsed.catalog;
  })();

  const OTHER_PRIMARY: CrossingLane = {
    id: "other-sub",
    label: "Other harness",
    billing: "subscription",
    caps: { dailyBudgetUsd: null },
  };

  const skillsEnv = {
    OTHER_TOKEN: "t",
    OTHER_API_KEY: "k",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    ANTHROPIC_API_KEY: "sk-ant",
  };

  /** A grill-me session with the other harness's lane in force. The lane
   * reports no quota, so `observation` is null and nothing is walled. */
  function session(over: Partial<LaneCrossingInput> = {}) {
    return crossing({
      sessionSkill: "grill-me",
      primary: OTHER_PRIMARY,
      catalog: skillsCatalog,
      env: skillsEnv,
      observation: null,
      ...over,
    });
  }

  it("routes the session onto the lane that can host it", () => {
    const decision = session();

    expect(decision.laneId).toBe("subscription");
    expect(decision.overflowedFrom).toBe("other-sub");
    expect(decision.billing).toBe("subscription");
    expect(decision.refusal).toBeNull();
    // Nothing costs money and no wall stands, so there is nothing to announce.
    expect(decision.notice).toBeNull();
  });

  it("refuses with the lane-by-lane reason when nothing can host it, rather than falling back", () => {
    // The Claude lanes' credentials are gone. Before this ticket the session
    // would have fallen back onto the lane in force and started as chat.
    const decision = session({ env: { OTHER_TOKEN: "t", OTHER_API_KEY: "k" } });

    expect(decision.refusal?.reason).toBe("no-skill-capable-lane");
    expect(decision.refusal?.message).toContain("grill-me session");
    expect(decision.refusal?.message).toContain(`other-sub, other-api run ${NO_SKILLS}`);
    expect(decision.refusal?.message).toContain("cannot invoke a skill");
    expect(decision.refusal?.message).toContain("subscription needs CLAUDE_CODE_OAUTH_TOKEN");
    expect(decision.refusal?.message).toContain("direct-api needs ANTHROPIC_API_KEY");
    expect(decision.notice).toBeNull();
  });

  it("holds the session on the clock when the one lane that could host it is only walled", () => {
    const decision = session({
      env: { OTHER_TOKEN: "t", OTHER_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "oauth" },
      observations: { subscription: WALL },
    });

    // A wall lifts itself, so this is a hold like a walled chat's — not the
    // entry refusal, which is for a fleet only the operator can change. The
    // message still names the wall and its reset.
    expect(decision.refusal?.reason).toBe("skill-lane-walled");
    expect(decision.refusal?.message).toContain(
      "subscription's window is exhausted (resets 14:05)"
    );
    expect(decision.refusal?.message).toContain("starts when a window that can host it resets");
    // Not #173's wall refusal either: the lane in force is not walled, it
    // cannot host the session at all, and a reset would change nothing there.
    expect(decision.walled).toBe(false);
  });

  it("routes the session off an unavailable lane in force that could not have hosted it anyway", () => {
    // #172's rule leaves a pass on an unavailable lane to die naming the
    // variable rather than routing around a misconfiguration. A session was
    // never going to run on this lane — setting its credential would change
    // nothing — so the ranking judges it as if the credential were present.
    const decision = session({
      env: { OTHER_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "oauth", ANTHROPIC_API_KEY: "sk-ant" },
    });

    expect(decision.laneId).toBe("subscription");
    expect(decision.refusal).toBeNull();
    // ...while an ordinary chat on that lane is still #172's report, unchanged.
    expect(session({ sessionSkill: null, env: { OTHER_API_KEY: "k" } }).laneId).toBe("other-sub");
  });

  it("refuses at entry when the lane in force is unavailable and nothing else can host it", () => {
    const decision = session({ env: { OTHER_API_KEY: "k" } });

    expect(decision.refusal?.reason).toBe("no-skill-capable-lane");
    expect(decision.refusal?.message).toContain(`other-sub, other-api run ${NO_SKILLS}`);
    expect(decision.refusal?.message).toContain("subscription needs CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("asks for the press when the only lane that can host it is a paid one", () => {
    // Money is a press away, so this is #174's hold with its own sentence —
    // not a refusal that sends the human to reconfigure the fleet.
    const decision = session({
      env: { OTHER_TOKEN: "t", OTHER_API_KEY: "k", ANTHROPIC_API_KEY: "sk-ant" },
      confirmedAt: null,
    });

    expect(decision.refusal?.reason).toBe("unconfirmed");
    expect(decision.refusal?.message).toContain("Anthropic API");
    expect(decision.laneId).toBe("direct-api");
  });

  it("names a pin that holds the session on a lane that cannot host it", () => {
    const decision = session({ pinnedLaneId: "other-sub" });

    expect(decision.refusal?.reason).toBe("no-skill-capable-lane");
    expect(decision.refusal?.message).toContain("pinned to other-sub");
    expect(decision.laneId).toBe("other-sub");
  });

  it("leaves an ordinary chat on the same lane in force exactly as before", () => {
    const decision = session({ sessionSkill: null });

    expect(decision.laneId).toBe("other-sub");
    expect(decision.overflowedFrom).toBeNull();
    expect(decision.refusal).toBeNull();
  });

  it.each(["implement", "review", "triage", "repair"] as const)(
    "never refuses a %s pass by it, even handed a session skill",
    (kind) => {
      const decision = session({ kind, env: { OTHER_TOKEN: "t", OTHER_API_KEY: "k" } });

      expect(decision.laneId).toBe("other-sub");
      expect(decision.refusal).toBeNull();
    }
  );

  it("tells a walled Claude session why the paid lane on another harness did not count", () => {
    // The Claude subscription is walled and the only other lane bills per token
    // on a harness that cannot invoke a skill. The wall refusal has to say so,
    // or "no paid lane to overflow onto" reads as a lie beside a declared one.
    const decision = crossing({
      sessionSkill: "to-tickets",
      catalog: skillsCatalog,
      env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth", OTHER_API_KEY: "k" },
    });

    expect(decision.refusal?.reason).toBe("no-metered-lane");
    expect(decision.refusal?.message).toContain("direct-api needs ANTHROPIC_API_KEY");
    expect(decision.refusal?.message).toContain(`other-api runs ${NO_SKILLS}, which cannot invoke a skill`);
  });
});
