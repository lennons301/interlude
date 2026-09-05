import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HarnessOutcomes } from "../fleet/harness-outcomes";
import type { FleetView, HarnessOutcome, HarnessView } from "@/lib/fleet/fleet-view";

/**
 * The Harnesses panel's own job (issue #223). What the read model decides is
 * tested in `fleet-view.test.ts`; this covers that a row *reads* on the
 * screen — attempts, burned attempts, verdicts, and the spend over the passes
 * it is attributed across — that a week with nothing claimed says so, and that
 * a row from before the stamp is called unknown rather than being handed to an
 * adapter.
 */

function row(overrides: Partial<HarnessOutcome> = {}): HarnessOutcome {
  return {
    harness: "claude-code",
    attempts: 1,
    tickets: 1,
    failed: 0,
    verdicts: { approve: 0, requestChanges: 0, escalate: 0 },
    passes: 1,
    spendUsd: 0,
    ...overrides,
  };
}

function render(harnesses: HarnessView): string {
  return renderToStaticMarkup(<HarnessOutcomes view={{ harnesses } as FleetView} />);
}

const EMPTY: HarnessView = { windowDays: 7, byHarness: [] };

const WEEK: HarnessView = {
  windowDays: 7,
  byHarness: [
    row({
      harness: "claude-code",
      attempts: 1,
      tickets: 1,
      verdicts: { approve: 1, requestChanges: 0, escalate: 0 },
      passes: 2,
      spendUsd: 12.5,
    }),
    row({
      harness: "codex",
      attempts: 3,
      tickets: 2,
      failed: 2,
      verdicts: { approve: 0, requestChanges: 1, escalate: 1 },
      passes: 4,
      spendUsd: 11.25,
    }),
  ],
};

describe("harness outcomes panel", () => {
  it("says so when nothing was claimed", () => {
    const html = render(EMPTY);

    expect(html).toContain("no tickets claimed this week");
    expect(html).not.toContain("<table");
  });

  it("renders one row per harness with attempts, tickets, burned attempts, verdicts, passes and spend", () => {
    const html = render(WEEK);

    expect(html).toContain("claude-code");
    expect(html).toContain("1 attempt · 1 ticket");
    expect(html).toContain("1 approve");
    expect(html).toContain("2 passes");
    expect(html).toContain("$12.50");

    expect(html).toContain("codex");
    expect(html).toContain("3 attempts · 2 tickets");
    expect(html).toContain("2 failed");
    expect(html).toContain("1 changes / 1 escalate");
    expect(html).toContain("4 passes");
    expect(html).toContain("$11.25");
  });

  it("paints only burned attempts red — a harness is a name, not a severity", () => {
    expect(render({ ...WEEK, byHarness: [row({ failed: 0 })] })).not.toContain("text-fl-red");
    expect(render({ ...WEEK, byHarness: [row({ failed: 1 })] })).toContain("text-fl-red");
  });

  it("shows rows from before the stamp as unknown, quietly, and says when a row has no verdicts", () => {
    const html = render({ ...WEEK, byHarness: [row({ harness: null, passes: 1 })] });

    expect(html).toContain("unknown harness");
    expect(html).toContain("no verdicts");
    expect(html).toContain("1 pass<");
  });
});
