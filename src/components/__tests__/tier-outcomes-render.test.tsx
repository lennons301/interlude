import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TierOutcomes } from "../fleet/tier-outcomes";
import type { FleetView, TierOutcome, TierView } from "@/lib/fleet/fleet-view";

/**
 * The Tiers panel's own job (issue #198). What the read model decides is
 * tested in `fleet-view.test.ts`; this covers that the two figures it carries
 * *read* on the screen — coverage with the undeclared claims said out loud,
 * and one row per tier with attempts, burned attempts, verdicts and spend —
 * and that a week with nothing claimed says so rather than drawing an empty
 * table that reads as 0% coverage.
 */

function row(overrides: Partial<TierOutcome> = {}): TierOutcome {
  return {
    tier: "standard",
    attempts: 1,
    tickets: 1,
    failed: 0,
    declared: 1,
    degraded: 0,
    verdicts: { approve: 0, requestChanges: 0, escalate: 0 },
    spendUsd: 0,
    ...overrides,
  };
}

function render(tiers: TierView): string {
  return renderToStaticMarkup(<TierOutcomes view={{ tiers } as FleetView} />);
}

const EMPTY: TierView = {
  windowDays: 7,
  coverage: { claimed: 0, declared: 0, undeclared: 0, percent: null },
  byTier: [],
};

const WEEK: TierView = {
  windowDays: 7,
  coverage: { claimed: 4, declared: 2, undeclared: 2, percent: 50 },
  byTier: [
    row({
      tier: "heavy",
      attempts: 1,
      tickets: 1,
      declared: 1,
      verdicts: { approve: 1, requestChanges: 0, escalate: 0 },
      spendUsd: 12.5,
    }),
    row({
      tier: "light",
      attempts: 3,
      tickets: 2,
      failed: 2,
      declared: 1,
      degraded: 1,
      verdicts: { approve: 0, requestChanges: 1, escalate: 1 },
      spendUsd: 11.25,
    }),
  ],
};

describe("tier outcomes panel", () => {
  it("says so when nothing was claimed, and claims no coverage", () => {
    const html = render(EMPTY);

    expect(html).toContain("no tickets claimed this week");
    expect(html).not.toContain("declared");
    expect(html).not.toContain("<table");
  });

  it("puts coverage in the header and says how many claims declared none", () => {
    const html = render(WEEK);

    expect(html).toContain("2/4 declared · 50%");
    expect(html).toContain("2 attempts ran on the default tier");
  });

  it("renders one row per tier with attempts, tickets, burned attempts, verdicts and spend", () => {
    const html = render(WEEK);

    expect(html).toContain("heavy");
    expect(html).toContain("1 attempt · 1 ticket");
    expect(html).toContain("1 approve");
    expect(html).toContain("$12.50");

    expect(html).toContain("light");
    expect(html).toContain("3 attempts · 2 tickets");
    expect(html).toContain("2 failed");
    expect(html).toContain("1 changes / 1 escalate");
    expect(html).toContain("1 declared, 1 stepped down");
    expect(html).toContain("$11.25");
  });

  it("paints only burned attempts red — a tier is a name, not a severity", () => {
    const clean = render({
      ...WEEK,
      byTier: [row({ tier: "heavy", failed: 0 })],
    });
    expect(clean).not.toContain("text-fl-red");

    const burned = render({
      ...WEEK,
      byTier: [row({ tier: "heavy", failed: 1 })],
    });
    expect(burned).toContain("text-fl-red");
  });

  it("shows runs that recorded no tier as their own quiet row, and says when a row has no verdicts", () => {
    const html = render({
      ...WEEK,
      byTier: [row({ tier: null, declared: 0 })],
    });

    expect(html).toContain("no tier");
    expect(html).toContain("no verdicts");
    expect(html).toContain("0 declared");
  });
});
