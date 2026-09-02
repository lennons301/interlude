import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SettingFieldView } from "@/lib/settings-resolver";

/**
 * The quota threshold panel (issue #171). What is asserted is the reading an
 * operator gets: the value in force, where it came from, and the fact that
 * clearing it is one press — the same contract the model-tier panel keeps,
 * checked here because the two panels share plumbing but not copy.
 *
 * The loaded state is stood up by mocking the one GET hook: the endpoint hands
 * back *every* settable field, so the fixture includes a model-tier row the
 * panel must ignore.
 */
let fields: SettingFieldView[] = [];

vi.mock("@/lib/use-load", () => ({
  useLoad: () => ({
    data: { fields, updatedAt: null },
    error: null,
    reload: () => {},
    setData: () => {},
  }),
}));

import { QuotaGateSettings } from "../quota-gate-settings";

const TIER_FIELD: SettingFieldView = {
  key: "modelTierReview",
  label: "Review",
  help: "The tier a review pass runs on.",
  envVar: "AGENT_MODEL_REVIEW",
  options: ["heavy", "standard", "light"],
  source: "environment",
  override: null,
  envValue: "claude-opus-4-8",
  detail: { kind: "model-tier", tier: null, model: "claude-opus-4-8" },
};

function field(over: Partial<SettingFieldView> = {}): SettingFieldView {
  return {
    key: "quotaPickupThresholdPercent",
    label: "Quota pickup threshold",
    help: "How full the account's quota window may get.",
    envVar: "QUOTA_PICKUP_THRESHOLD_PERCENT",
    options: ["80", "90", "95"],
    source: "environment",
    override: null,
    envValue: null,
    detail: { kind: "percent", percent: 90 },
    ...over,
  };
}

function render(over: Partial<SettingFieldView> = {}): string {
  fields = [TIER_FIELD, field(over)];
  return renderToStaticMarkup(<QuotaGateSettings />);
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

  it("ignores the model-tier fields the same endpoint hands back", () => {
    const html = render();

    expect(html).not.toContain("AGENT_MODEL_REVIEW");
    expect(html).not.toContain("claude-opus-4-8");
  });

  it("reads a falling-through field as the environment's, naming the variable", () => {
    const html = render();

    expect(html).toContain("holds pickup at 90%");
    expect(html).toContain("from QUOTA_PICKUP_THRESHOLD_PERCENT unset");
  });

  it("reads an overridden field as this screen's, and says where clearing lands", () => {
    const html = render({
      source: "override",
      override: "80",
      envValue: "95",
      detail: { kind: "percent", percent: 80 },
    });

    expect(html).toContain("ui override");
    expect(html).toContain("holds pickup at 80%");
    expect(html).toContain("QUOTA_PICKUP_THRESHOLD_PERCENT = 95, unused");
  });

  it("checks the option in force, so the control shows the state", () => {
    const html = render({
      source: "override",
      override: "80",
      detail: { kind: "percent", percent: 80 },
    });
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
});
