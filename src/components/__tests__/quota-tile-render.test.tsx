import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QuotaTile } from "../fleet/quota-tile";
import type { QuotaGlance, QuotaLaneGlance } from "@/lib/fleet/fleet-view";

/**
 * The quota tile (issue #167). What the read model decides is tested in
 * `fleet-view.test.ts`; what this covers is the tile's own job — that each of
 * the states it can be in says something true, including the ones where the
 * fleet knows less than the tile's shape suggests, and (issue #219) that a
 * lane whose harness cannot report is told apart from one that has not yet.
 */

const NOW = new Date("2026-09-01T12:00:00.000Z").getTime();

/** The gauge's own geometry — the 3px hairline bar, and nothing else in the
 * tile, is drawn at this height. */
const GAUGE = "h-[3px]";

/** The subscription lane on Claude Code — a harness that reports a window. */
const SUBSCRIPTION_LANE: QuotaLaneGlance = {
  id: "claude-subscription",
  label: "Claude subscription",
  billing: "subscription",
  adapter: "claude-code",
  reportsQuota: true,
};

/** A metered lane on Claude Code: the harness *could* report, the provider
 * behind it does not (issue #175) — so nothing has been observed, and the
 * lane is bounded by spend. */
const METERED_LANE: QuotaLaneGlance = {
  id: "openrouter-glm",
  label: "OpenRouter (GLM open weights)",
  billing: "metered",
  adapter: "claude-code",
  reportsQuota: true,
};

/** A subscription lane on a harness that emits no quota telemetry at all
 * (issue #219) — subscription-billed, and still can never report. */
const SILENT_LANE: QuotaLaneGlance = {
  id: "codex-subscription",
  label: "Codex subscription",
  billing: "subscription",
  adapter: "codex",
  reportsQuota: false,
};

function render(
  quota: QuotaGlance | null,
  lane: QuotaLaneGlance | null = SUBSCRIPTION_LANE
): string {
  return renderToStaticMarkup(<QuotaTile quota={quota} lane={lane} now={NOW} />);
}

const OBSERVED: QuotaGlance = {
  status: "allowed_warning",
  severity: "warning",
  limitLabel: "weekly opus",
  utilization: 91,
  resetsAt: "2026-09-01T14:30:00.000Z",
  observedAt: "2026-09-01T11:45:00.000Z",
};

describe("quota tile", () => {
  it("renders sensibly before anything has been observed", () => {
    // A fresh install on a lane that could report a window. It must not read
    // as a quota of zero.
    const html = render(null);

    expect(html).toContain("nothing observed yet");
    expect(html).toContain("no pass has reported a limit window");
    expect(html).not.toContain("0%");
    expect(html).not.toContain("cannot report");
  });

  it("shows utilization, the closest limit, its reset and when it was seen", () => {
    const html = render(OBSERVED);

    expect(html).toContain("91%");
    expect(html).toContain(GAUGE);
    expect(html).toContain("weekly opus");
    expect(html).toContain("resets in 2h 30m");
    expect(html).toContain("seen 15m ago");
    // Warning paints amber, in the system's own tone vocabulary.
    expect(html).toContain("allowed warning");
    expect(html).toContain("fl-amber");
  });

  it("omits the gauge when no utilization was reported", () => {
    // The usual shape of a real event: a bar drawn at zero would be a claim
    // the fleet never made.
    const html = render({ ...OBSERVED, utilization: null });

    expect(html).toContain("utilization not reported");
    expect(html).not.toContain(GAUGE);
  });

  it("says so when the event carried no reset time", () => {
    expect(render({ ...OBSERVED, resetsAt: null })).toContain("no reset reported");
  });

  it("does not count down a reset that has already passed", () => {
    // A five-hour window observed nine hours ago: the reading is stale, and
    // "resets in 0m" would read as imminent rather than as history.
    const html = render({ ...OBSERVED, resetsAt: "2026-09-01T09:00:00.000Z" });

    expect(html).toContain("reset time passed");
    expect(html).not.toContain("resets in");
  });

  it("goes quiet once the window it describes has reset", () => {
    // The tile's one inference, and the point of it: a red `rejected` chip
    // standing over a wall that lifted hours ago is crying wolf. The words
    // stay — it is still the last thing the fleet observed — and the colour,
    // and the bar that would make a claim about a spent window, go.
    const html = render({
      ...OBSERVED,
      status: "rejected",
      severity: "blocked",
      resetsAt: "2026-09-01T09:00:00.000Z",
    });

    expect(html).toContain("rejected");
    expect(html).not.toContain("fl-red");
    expect(html).not.toContain(GAUGE);
  });

  it("shows a live rejection in red, and a status it has never seen as itself", () => {
    // Live = its reset is still ahead, which OBSERVED's is.
    expect(render({ ...OBSERVED, status: "rejected", severity: "blocked" })).toContain(
      "fl-red"
    );

    const unknown = render({
      ...OBSERVED,
      status: "throttled_soft",
      severity: "unknown",
      utilization: null,
    });
    // Underscores read as spaces, as every other status does; the value is
    // still the CLI's own, not one this build substituted for it.
    expect(unknown).toContain("throttled soft");
    expect(unknown).toContain("border-fl-line");
  });

  it("says a lane whose harness emits no telemetry cannot report, whatever it bills (issue #219)", () => {
    // The distinction #175 drew, now keyed on the harness: "nothing observed"
    // implies a reading is coming, and on a harness without quota telemetry
    // none ever is — a subscription lane on it included. An operator told the
    // wrong one waits for a reading that never comes.
    const html = render(null, SILENT_LANE);

    expect(html).toContain("cannot report");
    expect(html).toContain("Codex subscription");
    expect(html).toContain("codex");
    expect(html).toContain("emits no quota telemetry");
    expect(html).not.toContain("nothing observed");
  });

  it("says nothing has been observed on a metered lane whose harness could report, and that it is bounded by spend", () => {
    // Claude Code can report a window; OpenRouter behind it does not. The tile
    // vouches only for the harness, and adds the fact that still helps: the
    // gauge above this tile is what bounds the lane.
    const html = render(null, METERED_LANE);

    expect(html).toContain("nothing observed yet");
    expect(html).toContain("bounded by spend");
    expect(html).toContain("OpenRouter (GLM open weights)");
    expect(html).not.toContain("cannot report");
  });

  it("falls back to the pending wording when no lane resolves at all", () => {
    // An unusable lanes.yaml: nothing is known about the lane, so the tile may
    // not claim it cannot report, nor that it is metered.
    const html = render(null, null);

    expect(html).toContain("nothing observed yet");
    expect(html).not.toContain("cannot report");
    expect(html).not.toContain("bounded by spend");
  });

  it("names the lane an observed reading belongs to, and the harness running it", () => {
    // With more than one lane declared, a reading with no owner is a reading
    // nobody can act on — and telemetry is the harness's capability (issues
    // #219, #223), so the lane row names which one.
    const html = render(OBSERVED);
    expect(html).toContain("Claude subscription");
    expect(html).toContain("claude-code");
  });
});
