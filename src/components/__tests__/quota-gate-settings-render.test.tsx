import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { QuotaThresholdView } from "@/lib/settings-resolver";
import { QuotaGatePanel } from "../quota-gate-settings";
import { errorFor } from "../settings-overrides";

/**
 * The quota-gate panel (issue #171). What is asserted is the reading an
 * operator gets: the threshold in force, where it came from, what clearing it
 * falls back to, and — because the whole point of the gate is that a fleet
 * claiming nothing must not look idle — what the gate does *not* hold.
 *
 * Presentational, so the view model is handed in directly.
 */

function quota(over: Partial<QuotaThresholdView> = {}): QuotaThresholdView {
  return {
    percent: 90,
    source: "environment",
    override: null,
    options: ["80", "90", "95"],
    label: "Quota pickup threshold",
    help: "How full the account's quota window may get.",
    envVar: "QUOTA_PICKUP_THRESHOLD_PERCENT",
    envValue: null,
    ...over,
  };
}

function render(over: Partial<QuotaThresholdView> = {}): string {
  return renderToStaticMarkup(
    <QuotaGatePanel
      quota={quota(over)}
      busy={false}
      disabled={false}
      saveError={null}
      onChoose={() => {}}
    />
  );
}

describe("the quota gate settings panel", () => {
  it("offers every threshold plus the way back to the environment", () => {
    const html = render();

    for (const option of ["80%", "90%", "95%", "environment"]) {
      expect(html).toContain(`>${option}</label>`);
    }
    // The chip reads as a percentage but the control carries the value the
    // fleet stores, so what is selected is inspectable in the row itself.
    expect(html).toContain('value="90"');
  });

  it("reads a falling-through field as the environment's, naming the variable", () => {
    const html = render();

    expect(html).toContain("holds pickup at 90%");
    expect(html).toContain("from QUOTA_PICKUP_THRESHOLD_PERCENT unset");
  });

  it("reads an overridden field as this screen's, and says where clearing lands", () => {
    const html = render({
      percent: 80,
      source: "override",
      override: "80",
      envValue: "95",
    });

    expect(html).toContain("ui override");
    expect(html).toContain("holds pickup at 80%");
    expect(html).toContain("QUOTA_PICKUP_THRESHOLD_PERCENT = 95, unused");
  });

  it("shows a refused environment value beside the default in force", () => {
    // Collapsing it to "unset" would read back as a variable nobody had set —
    // the one surprise the provenance line exists to remove.
    const html = render({ envValue: "93" });

    expect(html).toContain("holds pickup at 90%");
    expect(html).toContain("from QUOTA_PICKUP_THRESHOLD_PERCENT = 93");
  });

  it("checks the option in force, so the control shows the state", () => {
    const html = render({ percent: 80, source: "override", override: "80" });
    const input = (value: string) =>
      html.match(new RegExp(`<input[^>]*value="${value}"[^>]*>`))![0];

    expect(input("80")).toContain("checked");
    expect(input("90")).not.toContain("checked");
    expect(input("environment")).not.toContain("checked");
  });

  it("checks the environment option when the field falls through", () => {
    const html = render();
    const input = (value: string) =>
      html.match(new RegExp(`<input[^>]*value="${value}"[^>]*>`))![0];

    expect(input("environment")).toContain("checked");
    expect(input("90")).not.toContain("checked");
  });

  it("says what the gate does not hold, beside what it does", () => {
    // A fleet that looks busy while claiming nothing is the confusion this
    // panel has to head off at the point the threshold is chosen.
    const html = render();

    expect(html).toMatch(/in flight/i);
    expect(html).toMatch(/parked run still resumes/i);
    expect(html).toMatch(/kill switch/i);
  });

  it("shows only its own save error, never another panel's", () => {
    const laneFailure = { key: "primaryLane", message: "That didn't stick" };

    expect(errorFor(laneFailure, "quota")).toBeNull();
    expect(
      errorFor(
        { key: "quotaPickupThresholdPercent", message: "nope" },
        "quota"
      )
    ).toBe("nope");
    expect(
      errorFor({ key: "quotaPickupThresholdPercent", message: "nope" }, "tiers")
    ).toBeNull();
  });
});
