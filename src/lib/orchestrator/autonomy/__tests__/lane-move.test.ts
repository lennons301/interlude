import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../../config";
import { parseLaneConfig } from "../../../lanes/lane-config";
import {
  selectLaneFailover,
  type LaneSelection,
  type LaneSelectionInput,
} from "../../../lanes/lane-selection";
import type { QuotaObservation } from "../../../quota/rate-limit-event";
import type { SettingsOverrides } from "../../../settings-resolver";
import { decideManualLaneMove, type LaneMoveFacts } from "../lane-move";

/**
 * The operator's manual move of a parked run (issue #202), as the pure decision
 * the route's GET and POST both make. What the sweep gathers and what a move
 * writes are tested in `paused-runs.test.ts` over a real database; this is the
 * table of what the operator is told, from the same failover ranking, with no
 * database, no lane file on disk and no clock but the one passed in.
 *
 * The cases follow the ticket's acceptance criteria one by one: a parked run
 * is offered the move with the lane and its cost; a run that is not parked is
 * refused as such; the move answers to the money guards and says which press
 * would free it; it counts against the resume bound; and when nowhere can
 * serve the run the refusal names why rather than saying nothing.
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
  - id: open-weights
    label: Open weights
    adapter: claude-code
    billing: metered
    auth:
      ANTHROPIC_AUTH_TOKEN: THIRD_PARTY_KEY
    base_url: https://example.invalid/api
    models:
      heavy: vendor/big
      standard: vendor/flash
      light: vendor/mini
    prices:
      heavy: { input: 1.4, output: 4.4, cache_read: 0.26 }
      standard: { input: 0.075, output: 0.25, cache_read: 0.015 }
      light: { input: 0.06, output: 0.4, cache_read: 0.01 }
    caps:
      daily_budget_usd: 20
`;

const parsed = parseLaneConfig(LANES);
if (!parsed.ok) throw new Error(parsed.error);
const catalog = parsed.catalog;

const NOW = new Date("2026-09-04T10:00:00.000Z");
const RESUME_AFTER = new Date(NOW.getTime() + 4 * 60 * 60_000);

const WALL: QuotaObservation = {
  status: "rejected",
  rateLimitType: "five_hour",
  utilization: null,
  resetsAt: RESUME_AFTER,
  overageStatus: null,
  overageResetsAt: null,
  isUsingOverage: false,
  overageInUse: null,
  observedAt: NOW,
};

const FULL_ENV = {
  CLAUDE_CODE_OAUTH_TOKEN: "oauth",
  ANTHROPIC_API_KEY: "sk-ant",
  THIRD_PARTY_KEY: "sk-tp",
};

/** The failover ranking as the gatherer reads it for a run walled on the
 * subscription: that lane excluded, the day's cash confirmed unless a case
 * takes it away. */
function ranking(over: Partial<LaneSelectionInput> = {}): LaneSelection {
  return selectLaneFailover({
    catalog,
    env: FULL_ENV,
    kind: "implement",
    tier: "light",
    pinnedLaneId: null,
    primaryLaneId: "subscription",
    minLaneId: null,
    observations: { subscription: WALL },
    config: { meteredDailyCapUsd: 20 } as AppConfig,
    overrides: {} as SettingsOverrides,
    spentTodayUsd: 0,
    confirmedAt: NOW,
    now: NOW,
    ...over,
    fromLaneId: "subscription",
  });
}

function facts(over: Partial<LaneMoveFacts> = {}): LaneMoveFacts {
  return {
    runStatus: "rate_limited",
    hasLiveTask: false,
    passKind: "implement",
    resumesMade: 0,
    maxResumes: 3,
    fromLaneId: "subscription",
    resumeAfter: RESUME_AFTER,
    selection: ranking(),
    now: NOW,
    ...over,
  };
}

function refusal(over: Partial<LaneMoveFacts> = {}) {
  const decision = decideManualLaneMove(facts(over));
  if (decision.ok) throw new Error("expected a refusal, got an offer");
  return decision.refusal;
}

function offer(over: Partial<LaneMoveFacts> = {}) {
  const decision = decideManualLaneMove(facts(over));
  if (!decision.ok) throw new Error(`expected an offer, refused: ${decision.refusal.message}`);
  return decision.offer;
}

describe("a parked run is offered the move", () => {
  it("names the cheapest lane other than the walled one, and what it costs", () => {
    const move = offer();

    expect(move.toLaneId).toBe("open-weights");
    expect(move.toLaneLabel).toBe("Open weights");
    expect(move.billing).toBe("metered");
    expect(move.rateUsdPerMTok).toBeGreaterThan(0);
    // The same sentence the issue comment quotes — the screen and the record
    // cannot say different things about the money.
    expect(move.cost).toContain("bills real money");
    expect(move.cost).toContain("per million tokens");
    expect(move.fromLaneId).toBe("subscription");
  });

  it("says which continuation of the attempt it would be, against the bound", () => {
    const move = offer({ resumesMade: 1, maxResumes: 3 });

    expect(move.resume).toBe(2);
    expect(move.maxResumes).toBe(3);
  });

  it("says whether the wall it skips is still standing", () => {
    expect(offer().wallStands).toBe(true);
    expect(offer().resumeAfter).toBe(RESUME_AFTER.toISOString());

    // Past the reset the run's own lane is free again within the jitter
    // window; a move then pays for what waiting would do for nothing, which is
    // worth saying to someone about to pay.
    const past = offer({ resumeAfter: new Date(NOW.getTime() - 60_000) });
    expect(past.wallStands).toBe(false);

    const clockless = offer({ resumeAfter: null });
    expect(clockless.wallStands).toBe(false);
    expect(clockless.resumeAfter).toBeNull();
  });

  it("is the failover ranking's own pick, so the sweep and the press agree", () => {
    expect(offer().toLaneId).toBe(ranking().chosen?.id);
  });
});

describe("a run that is not parked", () => {
  it("is refused as such, naming its status", () => {
    const why = refusal({ runStatus: "implementing" });

    expect(why.reason).toBe("not-parked");
    expect(why.message).toContain("implementing");
    expect(why.message).toContain("only a parked run can be moved");
  });

  it("is refused before anything else is judged", () => {
    // Even with no ranking at all, the status is the answer.
    expect(refusal({ runStatus: "merged", selection: null }).reason).toBe("not-parked");
  });
});

describe("a run that is already resuming", () => {
  it("is refused rather than moved twice", () => {
    const why = refusal({ hasLiveTask: true });

    expect(why.reason).toBe("already-resuming");
    expect(why.message).toContain("already resuming");
  });
});

describe("a run with no pass to resume", () => {
  it("is refused as such", () => {
    expect(refusal({ passKind: null }).reason).toBe("no-pass");
  });
});

describe("the resume bound", () => {
  it("refuses a run that has spent every continuation, naming the bound", () => {
    const why = refusal({ resumesMade: 3, maxResumes: 3 });

    expect(why.reason).toBe("resume-bound");
    expect(why.message).toContain("all 3 of its continuations");
    expect(why.message).toContain("hands its ticket to a human");
  });

  it("is judged before the lanes — a run with none left is never going to resume anywhere", () => {
    // A lane is on offer and the day is confirmed; the bound still refuses.
    expect(ranking().chosen).not.toBeNull();
    expect(refusal({ resumesMade: 3 }).reason).toBe("resume-bound");
  });

  it("says when continuing after a pause is switched off altogether", () => {
    const why = refusal({ maxResumes: 0 });

    expect(why.reason).toBe("resume-bound");
    expect(why.message).toContain("switched off");
  });

  it("allows the last permitted continuation", () => {
    expect(offer({ resumesMade: 2, maxResumes: 3 }).resume).toBe(3);
  });
});

describe("the money guards", () => {
  it("refuses while the day's real money is unconfirmed, naming the lane a press would free", () => {
    const why = refusal({ selection: ranking({ confirmedAt: null }) });

    expect(why.reason).toBe("unconfirmed");
    expect(why.message).toContain("Open weights could serve this run");
    expect(why.message).toContain("real-money spend is not confirmed");
    expect(why.message).toContain("$0.00 of $20.00");
    expect(why.message).toContain("Confirm real-money spend first");
    expect(why.heldLane).toMatchObject({ id: "open-weights", capUsd: 20, spentUsd: 0 });
  });

  it("refuses at the cap, naming the cap and its remedy", () => {
    const why = refusal({ selection: ranking({ spentTodayUsd: 20 }) });

    expect(why.reason).toBe("cap-reached");
    expect(why.message).toContain("real-money cap of $20.00 is spent");
    expect(why.message).toContain("$20.00 on metered lanes");
    expect(why.message).toContain("Raise the cap");
    expect(why.heldLane?.id).toBe("open-weights");
  });

  it("offers a lane with headroom under its own cap while another is capped", () => {
    // Each lane is judged against its own declared cap inside the ranking;
    // the operator's dial is the ceiling on all of them.
    const move = offer({
      selection: ranking({
        spentTodayUsd: 20,
        config: { meteredDailyCapUsd: 50 } as AppConfig,
        catalog: {
          ...catalog,
          lanes: catalog.lanes.map((lane) =>
            lane.id === "direct-api"
              ? { ...lane, caps: { ...lane.caps, dailyBudgetUsd: 50 } }
              : lane
          ),
        },
      }),
    });

    expect(move.toLaneId).toBe("direct-api");
  });
});

describe("nowhere to go", () => {
  it("names the credential each other lane is missing", () => {
    const why = refusal({
      selection: ranking({ env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth" } }),
    });

    expect(why.reason).toBe("no-lane");
    expect(why.message).toContain("No other lane can serve this run");
    expect(why.message).toContain("direct-api needs ANTHROPIC_API_KEY");
    expect(why.message).toContain("open-weights needs THIRD_PARTY_KEY");
    expect(why.heldLane).toBeNull();
  });

  it("names the pass kind's floor when it excludes every other lane", () => {
    // A floor of the Anthropic-direct lane admits only first-party Claude;
    // with that lane's key absent nothing is left, and the refusal says both.
    const why = refusal({
      selection: ranking({
        minLaneId: "direct-api",
        env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth", THIRD_PARTY_KEY: "sk-tp" },
      }),
    });

    expect(why.reason).toBe("no-lane");
    expect(why.message).toContain("direct-api needs ANTHROPIC_API_KEY");
    expect(why.message).toContain(
      "open-weights is below the implement pass's minimum lane (direct-api)"
    );
  });

  it("names a pin to a lane that cannot serve the run", () => {
    // Pinned to a third lane whose credential is absent: the pin is not
    // released (the walled lane is not the pinned one), so the others read as
    // not candidates and the pinned one as unavailable.
    const why = refusal({
      selection: ranking({
        pinnedLaneId: "direct-api",
        env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth", THIRD_PARTY_KEY: "sk-tp" },
      }),
    });

    expect(why.reason).toBe("no-lane");
    expect(why.message).toContain("direct-api needs ANTHROPIC_API_KEY");
    expect(why.message).toContain("the fleet is pinned to direct-api");
    expect(why.message).toContain("so open-weights is not a candidate");
    // The walled lane is what the operator is leaving, never a reason.
    expect(why.message).not.toContain("subscription");
  });

  it("says so when the lane file could not be read", () => {
    const why = refusal({ selection: null });

    expect(why.reason).toBe("no-lane");
    expect(why.message).toContain("the lane file could not be read");
  });

  it("says so when no other lane is declared at all", () => {
    const why = refusal({
      selection: ranking({
        catalog: { ...catalog, lanes: catalog.lanes.filter((l) => l.id === "subscription") },
      }),
    });

    expect(why.reason).toBe("no-lane");
    expect(why.message).toContain("no lane other than subscription is declared");
  });
});
