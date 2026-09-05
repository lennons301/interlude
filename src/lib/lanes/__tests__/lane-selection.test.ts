import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../config";
import type { QuotaObservation } from "../../quota/rate-limit-event";
import type { SettingsOverrides } from "../../settings-resolver";
import { HARNESS_ADAPTER_DESCRIPTORS } from "../../harness/descriptors";
import { FAKE_NO_SKILLS_HARNESS_ID, fakeNoSkillsDescriptor } from "@/test/fake-harness";
import { parseLaneConfig, type LaneCatalog } from "../lane-config";
import {
  failoverOption,
  laneBlendedRateUsd,
  laneCapabilityRank,
  laneCostRank,
  planLaneFailover,
  rankLanes,
  selectLane,
  selectLaneFailover,
  type LaneSelectionInput,
} from "../lane-selection";

/**
 * Cost-first lane selection (issue #176), tested as the pure function the
 * ticket asks for: no lane file on disk, no database, no Docker, no network
 * and no clock but the one passed in.
 *
 * The catalog below is the shipped file in miniature — a subscription lane, an
 * Anthropic-direct metered lane that declares no prices (because there the
 * harness's own figure is right), a third-party lane priced at Anthropic list
 * rates, and an open-weights lane roughly two orders of magnitude under it.
 * Those four are exactly the cases the ranking has to keep apart.
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
  - id: third-party
    label: Third party (Claude)
    adapter: claude-code
    billing: metered
    auth:
      ANTHROPIC_AUTH_TOKEN: THIRD_PARTY_KEY
    base_url: https://example.invalid/api
    models:
      heavy: vendor/claude-opus
      standard: vendor/claude-sonnet
      light: vendor/claude-haiku
    prices:
      heavy: { input: 15.0, output: 75.0, cache_read: 1.5, cache_write: 18.75 }
      standard: { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 }
      light: { input: 1.0, output: 5.0, cache_read: 0.1, cache_write: 1.25 }
    caps:
      daily_budget_usd: 20
  - id: open-weights
    label: Third party (open weights)
    adapter: claude-code
    billing: metered
    auth:
      ANTHROPIC_AUTH_TOKEN: THIRD_PARTY_KEY
    base_url: https://example.invalid/api
    models:
      heavy: vendor/big
      standard: vendor/flash
      light: vendor/tiny
    prices:
      heavy: { input: 1.4, output: 4.4, cache_read: 0.26 }
      standard: { input: 0.075, output: 0.25, cache_read: 0.015 }
      light: { input: 0.06, output: 0.4, cache_read: 0.01 }
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

const FULL_ENV = {
  CLAUDE_CODE_OAUTH_TOKEN: "oauth",
  ANTHROPIC_API_KEY: "sk-ant",
  THIRD_PARTY_KEY: "sk-tp",
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

/** The subscription window refusing work outright — the state that makes the
 * free lane unable to serve, however cheap it is. */
const WALL = observation({ status: "rejected", utilization: null });

function input(over: Partial<LaneSelectionInput> = {}): LaneSelectionInput {
  return {
    catalog,
    env: FULL_ENV,
    kind: "implement",
    tier: "standard",
    pinnedLaneId: null,
    // The lane in force. Named on every case, because two rules turn on it:
    // the floor never excludes it, and it is what a pass falls back to.
    primaryLaneId: "subscription",
    minLaneId: null,
    observations: {},
    config: { meteredDailyCapUsd: 20 } as AppConfig,
    overrides: {} as SettingsOverrides,
    spentTodayUsd: 0,
    // Confirmed today, so #174's press is never the thing under test unless a
    // case takes it away.
    confirmedAt: NOW,
    now: NOW,
    ...over,
  };
}

function chosen(over: Partial<LaneSelectionInput> = {}): string | null {
  return selectLane(input(over)).laneId;
}

function order(over: Partial<LaneSelectionInput> = {}): string[] {
  return rankLanes(input(over)).map((lane) => lane.id);
}

function reason(laneId: string, over: Partial<LaneSelectionInput> = {}) {
  return rankLanes(input(over)).find((lane) => lane.id === laneId)?.ineligible;
}

describe("what a lane costs, and what that says about it", () => {
  it("blends a lane's four price columns into one comparable rate", () => {
    const thirdParty = catalog.lanes.find((l) => l.id === "third-party")!;
    const openWeights = catalog.lanes.find((l) => l.id === "open-weights")!;

    // 100k input + 50k output + 750k cache read + 100k cache write, priced
    // through the same `priceTokens` the ledger charges from.
    expect(laneBlendedRateUsd(thirdParty, "standard")).toBeCloseTo(1.65, 6);
    // An absent cache-write price is charged at the input rate, not at zero —
    // the rule `lane-cost.ts` already owns, inherited rather than restated.
    expect(laneBlendedRateUsd(openWeights, "standard")).toBeCloseTo(0.03875, 6);
  });

  it("prices a lane at the tier the pass would actually run", () => {
    const openWeights = catalog.lanes.find((l) => l.id === "open-weights")!;
    const heavy = laneBlendedRateUsd(openWeights, "heavy")!;
    const light = laneBlendedRateUsd(openWeights, "light")!;
    expect(heavy).toBeGreaterThan(light);
  });

  it("declares no rate for a lane that declares no prices", () => {
    const subscription = catalog.lanes.find((l) => l.id === "subscription")!;
    expect(laneBlendedRateUsd(subscription, "standard")).toBeNull();
  });

  it("costs a subscription lane nothing at the margin — its quota is bought", () => {
    const subscription = catalog.lanes.find((l) => l.id === "subscription")!;
    expect(laneCostRank(subscription, "standard", false)).toBe(0);
  });

  it("costs an overage-covered subscription lane an unread price, not nothing", () => {
    // The card is being charged and this file cannot say at what rate, so the
    // cautious answer ranks it with the other unread prices — which is also
    // what makes a lane whose price *is* written down the cheaper choice.
    const subscription = catalog.lanes.find((l) => l.id === "subscription")!;
    expect(laneCostRank(subscription, "standard", true)).toBe(Infinity);
  });

  it("costs an unpriced metered lane an unread price — expensive, cautiously", () => {
    const directApi = catalog.lanes.find((l) => l.id === "direct-api")!;
    expect(laneCostRank(directApi, "standard", false)).toBe(Infinity);
  });

  it("ranks an unpriced lane at the top on capability, the same fact read back", () => {
    // Anthropic-direct: first-party Claude at list rates. Last on cost because
    // the rate is unread; first on capability because of what it runs.
    const directApi = catalog.lanes.find((l) => l.id === "direct-api")!;
    const openWeights = catalog.lanes.find((l) => l.id === "open-weights")!;
    expect(laneCapabilityRank(directApi, "standard")).toBe(Infinity);
    expect(laneCapabilityRank(openWeights, "standard")).toBeLessThan(
      laneCapabilityRank(catalog.lanes.find((l) => l.id === "third-party")!, "standard")
    );
  });
});

describe("the ranking", () => {
  it("orders cheapest first, and puts unread prices last", () => {
    expect(order()).toEqual([
      "subscription",
      "open-weights",
      "third-party",
      "direct-api",
    ]);
  });

  it("breaks a tie on the file's own preference order", () => {
    // With an overage paying for it, the subscription lane joins the
    // unread-price class and ties with the Anthropic-direct lane. The
    // deployment's stated ranking of who it would rather pay decides — which
    // is what #173 used to pick an overflow target, surviving here as the
    // tie-break rather than as the rule.
    const overage = observation({
      status: "rejected",
      overageStatus: "allowed",
      isUsingOverage: true,
    });
    expect(order({ observations: { subscription: overage } })).toEqual([
      "open-weights",
      "third-party",
      "subscription",
      "direct-api",
    ]);
  });

  it("has nothing to rank without a catalog to read", () => {
    expect(rankLanes(input({ catalog: null }))).toEqual([]);
  });
});

describe("cost-first selection", () => {
  it("leaves a healthy fleet on the subscription — nothing is cheaper than paid-for", () => {
    // The property that made cost routing safe to make the default: in the
    // shipped configuration it is a no-op until a wall.
    expect(chosen()).toBe("subscription");
  });

  it("picks the cheapest lane that can serve the pass once the window is walled", () => {
    expect(chosen({ observations: { subscription: WALL } })).toBe("open-weights");
    expect(reason("subscription", { observations: { subscription: WALL } })).toBe(
      "walled"
    );
  });

  it("keeps a pass off a lane whose credentials are absent", () => {
    expect(
      chosen({
        observations: { subscription: WALL },
        env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth", ANTHROPIC_API_KEY: "sk-ant" },
      })
    ).toBe("direct-api");
  });

  it("moves off a lane an overage has started billing, onto a priced one", () => {
    const overage = observation({
      status: "rejected",
      overageStatus: "allowed",
      isUsingOverage: true,
    });
    expect(chosen({ observations: { subscription: overage } })).toBe(
      "open-weights"
    );
  });
});

describe("a pass kind's minimum lane", () => {
  const walled = { observations: { subscription: WALL } };

  it("admits the lane it names", () => {
    expect(chosen({ ...walled, minLaneId: "open-weights" })).toBe("open-weights");
  });

  it("excludes everything cheaper than the lane it names", () => {
    expect(chosen({ ...walled, minLaneId: "third-party" })).toBe("third-party");
    expect(reason("open-weights", { ...walled, minLaneId: "third-party" })).toBe(
      "below-floor"
    );
  });

  it("still allows the subscription above a paid floor — it is free and first-party", () => {
    // The reason a floor is expressed in capability rather than in cost: an
    // implement pass floored at a paid lane must not thereby be barred from
    // the lane the fleet has already paid for.
    expect(chosen({ minLaneId: "third-party" })).toBe("subscription");
  });

  it("means first-party Claude only when it names an Anthropic-direct lane", () => {
    expect(chosen({ ...walled, minLaneId: "direct-api" })).toBe("direct-api");
    expect(reason("third-party", { ...walled, minLaneId: "direct-api" })).toBe(
      "below-floor"
    );
  });

  it("never excludes the lane in force — a floor bounds where routing *sends* a pass", () => {
    // Without this the floor would either silently be ignored (the pass runs
    // on the lane in force anyway, making the setting a lie) or refuse a pass
    // with nowhere else to go. The lane in force still answers to everything
    // about whether it can *serve* the request.
    // The deployment's only credential is the third party's, so open-weights
    // is the lane in force and the floor above it is unsatisfiable.
    const onlyThirdParty = {
      primaryLaneId: "open-weights",
      minLaneId: "direct-api",
      env: { THIRD_PARTY_KEY: "sk-tp" },
    };
    expect(chosen(onlyThirdParty)).toBe("open-weights");
    expect(reason("open-weights", onlyThirdParty)).toBeNull();
    // The floor still bites on everything that *is* a routing choice.
    expect(reason("third-party", onlyThirdParty)).toBe("below-floor");
    // ...but it is excluded once it cannot serve the pass, floor or no floor.
    expect(
      chosen({
        primaryLaneId: "subscription",
        minLaneId: "direct-api",
        observations: { subscription: WALL },
      })
    ).toBe("direct-api");
  });

  it("ignores a floor naming no declared lane rather than stopping the fleet", () => {
    // The file is version-controlled and the setting is not, so a lane renamed
    // in a deploy must not read as "nothing qualifies". The settings screen
    // refuses an unknown id by name at the point of writing instead.
    expect(chosen({ ...walled, minLaneId: "retired-lane" })).toBe("open-weights");
  });
});

describe("the money guards decide inside the ranking, not beside it", () => {
  const walled = { observations: { subscription: WALL } };

  it("holds every paid lane until the day's cash is confirmed", () => {
    const selection = selectLane(input({ ...walled, confirmedAt: null }));

    expect(selection.laneId).toBeNull();
    // Named, so a caller with a human in front of it can ask for the press.
    expect(selection.heldForMoney?.id).toBe("open-weights");
    expect(selection.heldForMoney?.money?.hold).toBe("unconfirmed");
  });

  it("holds a paid lane whose own declared cap is spent", () => {
    expect(reason("open-weights", { ...walled, spentTodayUsd: 20 })).toBe(
      "cap-reached"
    );
  });

  it("judges each lane against its own cap, so one with headroom still serves", () => {
    // The lane cap and the operator's dial bind per lane and the lower wins
    // (#174), so a lane declaring $5 is spent while its neighbours are not.
    const tight = `${LANES}`.replace(
      "      daily_budget_usd: 20\n  - id: third-party",
      "      daily_budget_usd: 5\n  - id: third-party"
    );
    const parsed = parseLaneConfig(tight);
    if (!parsed.ok) throw new Error(parsed.reason);

    const at6 = input({
      catalog: parsed.catalog,
      observations: { subscription: WALL },
      spentTodayUsd: 6,
    });
    expect(reason("direct-api", at6)).toBe("cap-reached");
    expect(selectLane(at6).laneId).toBe("open-weights");
  });

  it("admits a lane with no quota telemetry on spend, never on another lane's wall", () => {
    // #171's rule, and the reason `quota_state` is keyed by lane (#175): a
    // metered provider reports no window at all, and silence a lane cannot
    // break must never read as a closed door.
    // The walled lane is the only one with an observation at all, and the
    // ranking is handed nothing for the rest.
    const selection = selectLane(input(walled));
    const target = selection.candidates.find((l) => l.id === "open-weights")!;

    expect(selection.laneId).toBe("open-weights");
    expect(target.ineligible).toBeNull();
    // Admitted on spend: the guards ran, found headroom under a confirmed day,
    // and nothing about the subscription's wall reached this lane.
    expect(target.money?.hold).toBeNull();
    expect(target.money?.metered).toBe(true);
  });
});

describe("the escape hatch: a pinned fleet", () => {
  it("considers only the pinned lane, however cheap the others are", () => {
    expect(chosen({ pinnedLaneId: "direct-api" })).toBe("direct-api");
    expect(reason("open-weights", { pinnedLaneId: "direct-api" })).toBe(
      "not-pinned"
    );
  });

  it("selects nothing when the pinned lane is unavailable — that is #172's report", () => {
    // Routing around an operator's decision is what that ticket refuses, and
    // papering over a missing credential by spending at another provider is
    // the worst version of it.
    expect(
      selectLane(
        input({
          pinnedLaneId: "subscription",
          env: { ANTHROPIC_API_KEY: "sk-ant", THIRD_PARTY_KEY: "sk-tp" },
        })
      ).laneId
    ).toBeNull();
  });

  it("is released by a wall, because a wall is not a preference", () => {
    // #173 crossed an attended session off a walled lane whether or not it was
    // pinned, and that keeps being true: a pin says "do not choose for me",
    // where a wall says the chosen lane cannot serve the request at all.
    expect(
      chosen({ pinnedLaneId: "subscription", observations: { subscription: WALL } })
    ).toBe("open-weights");
  });

  it("still holds while the pinned lane can serve the pass", () => {
    // Released only by a wall — not by a cheaper lane existing, which is the
    // whole point of pinning.
    expect(chosen({ pinnedLaneId: "direct-api" })).toBe("direct-api");
  });

  it("reports the pin so a caller can say why nothing was chosen", () => {
    expect(selectLane(input({ pinnedLaneId: "direct-api" })).pinnedLaneId).toBe(
      "direct-api"
    );
    expect(selectLane(input()).pinnedLaneId).toBeNull();
  });
});

describe("the failover a wall buys", () => {
  const walled = { observations: { subscription: WALL } };

  it("never hands back the lane that refused the pass", () => {
    const move = planLaneFailover({
      ...input(walled),
      fromLaneId: "open-weights",
    });
    // Not the walled subscription either — it cannot serve — so the next
    // cheapest lane whose price is written down.
    expect(move?.toLaneId).toBe("third-party");
    expect(move?.billing).toBe("metered");
    expect(move?.rateUsdPerMTok).toBeCloseTo(1.65, 6);
  });

  it("is the same ranking the routing is, so the two cannot disagree", () => {
    expect(
      planLaneFailover({ ...input(walled), fromLaneId: null })?.toLaneId
    ).toBe(chosen(walled));
  });

  it("has nowhere to go when every other lane is unavailable", () => {
    const move = planLaneFailover({
      ...input({ ...walled, env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth" } }),
      fromLaneId: "subscription",
    });
    expect(move).toBeNull();
  });

  it("has nowhere to go when the day's cash is unconfirmed — so the run pauses", () => {
    const move = planLaneFailover({
      ...input({ ...walled, confirmedAt: null }),
      fromLaneId: "subscription",
    });
    expect(move).toBeNull();
  });

  it("has nowhere to go when the cash cap is spent — so the run pauses", () => {
    const move = planLaneFailover({
      ...input({ ...walled, spentTodayUsd: 20 }),
      fromLaneId: "subscription",
    });
    expect(move).toBeNull();
  });

  it("respects the pass kind's floor, so a hard ticket is not moved onto anything", () => {
    const move = planLaneFailover({
      ...input({ ...walled, minLaneId: "direct-api" }),
      fromLaneId: "direct-api",
    });
    expect(move).toBeNull();
  });

  it("keeps a pinned fleet on its lane when that lane is not the one that refused", () => {
    // The pin is released by *this* lane's wall and nothing else, so a pinned
    // run refused somewhere else moves back onto the lane it was pinned to.
    const move = planLaneFailover({
      ...input({ pinnedLaneId: "direct-api" }),
      fromLaneId: "open-weights",
    });
    expect(move?.toLaneId).toBe("direct-api");
  });

  it("still fires for a pinned fleet, because the pinned lane is the walled one", () => {
    // The pin is honoured right up to the point where the lane cannot serve
    // the request; past it, waiting five hours is not what pinning asked for.
    const move = planLaneFailover({
      ...input({ ...walled, pinnedLaneId: "subscription" }),
      fromLaneId: "subscription",
    });
    expect(move?.toLaneId).toBe("open-weights");
  });
});

describe("the failover ranking, kept whole (issue #202)", () => {
  const walled = { observations: { subscription: WALL } };

  it("is what the failover option is reduced from, so the two cannot disagree", () => {
    const selection = selectLaneFailover({ ...input(walled), fromLaneId: "subscription" });

    expect(failoverOption(selection)).toEqual(
      planLaneFailover({ ...input(walled), fromLaneId: "subscription" })
    );
    expect(selection.chosen?.id).toBe("open-weights");
  });

  it("marks the refused lane as already tried rather than dropping it", () => {
    const selection = selectLaneFailover({ ...input(walled), fromLaneId: "subscription" });

    expect(
      selection.candidates.find((lane) => lane.id === "subscription")?.ineligible
    ).toBe("already-tried");
  });

  it("keeps the lane a press would free, for a refusal to name", () => {
    // Nothing is chosen, but the reason is a press away — which the operator's
    // manual move has to say, and the reducer's option could not.
    const selection = selectLaneFailover({
      ...input({ ...walled, confirmedAt: null }),
      fromLaneId: "subscription",
    });

    expect(selection.chosen).toBeNull();
    expect(failoverOption(selection)).toBeNull();
    expect(selection.heldForMoney?.id).toBe("open-weights");
    expect(selection.heldForMoney?.ineligible).toBe("unconfirmed");
  });

  it("releases a pin naming the refused lane, and reports the pin as released", () => {
    const selection = selectLaneFailover({
      ...input({ ...walled, pinnedLaneId: "subscription" }),
      fromLaneId: "subscription",
    });

    expect(selection.pinnedLaneId).toBeNull();
    expect(selection.chosen?.id).toBe("open-weights");
  });
});

describe("a generation session runs only where its skill can be invoked (issue #218)", () => {
  // A second catalog with a lane on a harness that does not expand a
  // user-invoked skill — the shape a Codex or OpenCode lane will have — beside
  // the Claude lanes, so the requirement has something to bite on. The adapter
  // is the shared no-skills fake, described to the parser beside the
  // production table as a test's double is.
  const NO_SKILLS = FAKE_NO_SKILLS_HARNESS_ID;
  const skillsCatalog: LaneCatalog = (() => {
    const parsed = parseLaneConfig(
      `
primary:
  - no-skills-sub
  - subscription
lanes:
  - id: no-skills-sub
    label: Other harness (subscription)
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
  - id: no-skills-api
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

  const skillsEnv = {
    OTHER_TOKEN: "t",
    OTHER_API_KEY: "k",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth",
  };

  /** An ordinary chat on the other harness's subscription lane. */
  const chat: Partial<LaneSelectionInput> = {
    catalog: skillsCatalog,
    env: skillsEnv,
    kind: "interactive",
    sessionSkill: null,
    primaryLaneId: "no-skills-sub",
  };
  /** The same task, carrying a session skill. */
  const session: Partial<LaneSelectionInput> = { ...chat, sessionSkill: "grill-me" };

  it("passes over a lane whose harness cannot invoke skills, naming the reason", () => {
    expect(reason("no-skills-sub", session)).toBe("cannot-invoke-skills");
    expect(reason("no-skills-api", session)).toBe("cannot-invoke-skills");
    expect(reason("subscription", session)).toBeNull();
  });

  it("chooses the lane that can host it, off a lane in force that cannot", () => {
    // Both subscription lanes are free; the tie-break prefers the lane in
    // force — and it loses anyway, because it cannot host the session.
    expect(chosen(session)).toBe("subscription");
    expect(selectLane(input(session)).inForce?.ineligible).toBe("cannot-invoke-skills");
  });

  it("does not exempt the lane in force: a floor is a routing bound, a skill is what the pass is", () => {
    // The lane in force is exempt from the floor because it is where the pass
    // already is, not a place routing sends it. It is not exempt from this:
    // running a skill session where the skill cannot load is the failure, and
    // the fall-back onto the lane in force is exactly where it would happen.
    expect(reason("no-skills-sub", { ...session, minLaneId: "subscription" })).toBe(
      "cannot-invoke-skills"
    );
  });

  it("leaves an ordinary chat's choice exactly as it was", () => {
    expect(reason("no-skills-sub", chat)).toBeNull();
    expect(chosen(chat)).toBe("no-skills-sub");
    expect(order(chat)).toEqual(order({ ...chat, sessionSkill: undefined }));
  });

  it.each(["implement", "review", "triage", "repair"] as const)(
    "never filters a %s pass by it, even handed a session skill",
    (kind) => {
      // The requirement is derived from the pass — the schema's own predicate
      // for a generation session — so a ticket-loop kind cannot meet it. A
      // session skill on such a pass is nonsense the ranking must not act on.
      const ticketLoop = { ...session, kind };
      expect(reason("no-skills-sub", ticketLoop)).toBeNull();
      expect(reason("no-skills-api", ticketLoop)).toBeNull();
      expect(chosen(ticketLoop)).toBe("no-skills-sub");
    }
  );

  it("reports the harness before a missing credential — setting the variable would not help", () => {
    expect(
      reason("no-skills-sub", { ...session, env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth" } })
    ).toBe("cannot-invoke-skills");
  });

  it("still honours a pin: a fleet pinned to a lane that cannot host it chooses nothing", () => {
    // A pin is an operator's decision and only a wall releases it. Refusing
    // with the pin named is the honest answer; routing around it is what #172
    // exists to refuse.
    const selection = selectLane(input({ ...session, pinnedLaneId: "no-skills-sub" }));

    expect(selection.chosen).toBeNull();
    expect(selection.inForce?.ineligible).toBe("cannot-invoke-skills");
    expect(
      selection.candidates.find((lane) => lane.id === "subscription")?.ineligible
    ).toBe("not-pinned");
  });

  it("never reports a lane that cannot host it as held for money", () => {
    // The metered other-harness lane is unconfirmed too, but "confirm
    // real-money spend" would send the human to a press that changes nothing.
    const selection = selectLane(
      input({
        ...session,
        confirmedAt: null,
        env: { OTHER_TOKEN: "t", OTHER_API_KEY: "k" },
      })
    );

    expect(selection.chosen).toBeNull();
    expect(selection.heldForMoney).toBeNull();
  });

  it("carries each candidate's harness, so a refusal can say whose fact it is", () => {
    const byId = Object.fromEntries(
      rankLanes(input(session)).map((lane) => [lane.id, lane.adapter])
    );
    expect(byId).toEqual({
      "no-skills-sub": NO_SKILLS,
      "no-skills-api": NO_SKILLS,
      subscription: "claude-code",
    });
  });
});
