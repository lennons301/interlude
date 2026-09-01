import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QuotaTile } from "../fleet/quota-tile";
import type { QuotaGlance } from "@/lib/fleet/fleet-view";

/**
 * The quota tile (issue #167). What the read model decides is tested in
 * `fleet-view.test.ts`; what this covers is the tile's own job — that each of
 * the three states it can be in says something true, including the two where
 * the fleet knows less than the tile's shape suggests.
 */

const NOW = new Date("2026-09-01T12:00:00.000Z").getTime();

function render(quota: QuotaGlance | null): string {
  return renderToStaticMarkup(<QuotaTile quota={quota} now={NOW} />);
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
    // The state a fresh install is in, and the permanent state of a fleet on
    // API-key auth. It must not read as a quota of zero.
    const html = render(null);

    expect(html).toContain("not observed yet");
    expect(html).toContain("no pass has reported a limit window");
    expect(html).not.toContain("0%");
  });

  it("shows utilization, the closest limit, its reset and when it was seen", () => {
    const html = render(OBSERVED);

    expect(html).toContain("91%");
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
    expect(html).not.toContain("width:0%");
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

  it("shows a rejection in red, and a status it has never seen as itself", () => {
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
});
