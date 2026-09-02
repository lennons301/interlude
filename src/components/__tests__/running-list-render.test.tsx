import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunningList } from "../fleet/running-list";
import type { FleetView, RunningCard } from "@/lib/fleet/fleet-view";

/**
 * The Running list's own job. What the read model decides is tested in
 * `fleet-view.test.ts`; what this covers is that a quota-paused run (issue
 * #168) *reads* as paused on the screen rather than as work in progress — the
 * card is the whole of the ticket's dashboard promise, and "afk" over a run
 * waiting five hours on a quota window would be the dashboard claiming the
 * fleet is driving it.
 */

const NOW = new Date("2026-09-01T12:00:00.000Z").getTime();

const WORKING: RunningCard = {
  taskId: "t1",
  runId: "r1",
  projectName: "lemons",
  ticket: "#34",
  title: "Add pagination to the list",
  mode: "afk",
  sessionSkill: null,
  phases: [
    { name: "implement", state: "current" },
    { name: "review", state: "todo" },
    { name: "merge", state: "todo" },
  ],
  attempt: { current: 2, max: 3 },
  turns: 4,
  startedAt: "2026-09-01T09:00:00.000Z",
  spend: { usd: 7.8, budgetUsd: 20 },
  paused: null,
};

const PAUSED: RunningCard = {
  ...WORKING,
  paused: { reason: "rate-limited", resumeAfter: "2026-09-01T14:30:00.000Z" },
};

function render(cards: RunningCard[]): string {
  return renderToStaticMarkup(
    <RunningList view={{ running: cards } as FleetView} now={NOW} />
  );
}

describe("running list", () => {
  it("says a paused run is paused, and when it comes back", () => {
    const html = render([PAUSED]);

    expect(html).toContain("paused");
    expect(html).toContain("rate limited — resumes in 2h 30m");
    // In place of the mode, not beside it: two chips would leave the reader to
    // work out which one is current.
    expect(html).not.toContain(">afk<");
  });

  it("does not paint a paused run's phase as being worked", () => {
    // Green is the "an agent is in this phase" colour. Nothing is in it.
    expect(render([PAUSED])).not.toContain("text-fl-green");
    expect(render([WORKING])).toContain("text-fl-green");
  });

  it("says the window has reset once the clock has run out", () => {
    // Rather than counting down to nothing forever: past the reset the run is
    // waiting on the fleet, not on the quota.
    const html = render([
      { ...PAUSED, paused: { reason: "rate-limited", resumeAfter: "2026-09-01T11:00:00.000Z" } },
    ]);

    expect(html).toContain("quota window has reset");
    expect(html).not.toContain("resumes in");
  });

  it("leaves a working run reading exactly as it did", () => {
    const html = render([WORKING]);

    expect(html).toContain("afk");
    expect(html).not.toContain("paused");
    expect(html).not.toContain("rate limited");
  });
});
