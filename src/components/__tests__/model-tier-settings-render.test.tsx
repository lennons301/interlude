import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SettingFieldView } from "@/lib/settings-resolver";

/**
 * The provenance half of the settings panel (issue #166). The value in force is
 * only half an answer — an operator debugging a surprising tier needs to see
 * whether it came from this screen or from the deployment, and which variable
 * it would fall back to. That reading is the contract, so it is asserted rather
 * than left to a class-string edit to quietly drop.
 *
 * The loaded state is stood up by mocking the one GET hook: what matters here
 * is what the panel says about a resolved field, not how it fetched it.
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

import { ModelTierSettings } from "../model-tier-settings";

function field(over: Partial<SettingFieldView> = {}): SettingFieldView {
  return {
    key: "modelTierReview",
    group: "models",
    label: "Review",
    help: "The tier a review pass runs on.",
    envVar: "AGENT_MODEL_REVIEW",
    options: ["heavy", "standard", "light"],
    source: "environment",
    override: null,
    envValue: "claude-opus-4-8",
    tier: null,
    model: "claude-opus-4-8",
    ...over,
  };
}

function render(over: Partial<SettingFieldView> = {}): string {
  fields = [field(over)];
  return renderToStaticMarkup(<ModelTierSettings />);
}

describe("the model-tier settings panel", () => {
  it("offers every tier plus the way back to the environment", () => {
    const html = render();

    for (const option of ["heavy", "standard", "light", "environment"]) {
      expect(html).toContain(`>${option}</label>`);
    }
  });

  it("reads a falling-through field as the environment's, naming the variable", () => {
    const html = render();

    expect(html).toContain("environment");
    expect(html).toContain("from AGENT_MODEL_REVIEW = claude-opus-4-8");
  });

  it("reads an overridden field as this screen's, and says what it runs", () => {
    const html = render({
      source: "override",
      override: "light",
      tier: "light",
      model: "haiku",
    });

    expect(html).toContain("ui override");
    expect(html).toContain("runs light (haiku)");
    // The fall-back is still named: clearing the override lands there.
    expect(html).toContain("AGENT_MODEL_REVIEW = claude-opus-4-8, unused");
  });

  it("says plainly when nothing pins a model at all", () => {
    const html = render({ envValue: null, model: null, tier: null });

    expect(html).toContain("no --model — the account default");
    expect(html).toContain("AGENT_MODEL_REVIEW unset");
  });

  it("checks the option in force, so the control shows the state", () => {
    const html = render({
      source: "override",
      override: "light",
      tier: "light",
      model: "haiku",
    });
    const input = (value: string) =>
      html.match(new RegExp(`<input[^>]*value="${value}"[^>]*>`))![0];

    expect(input("light")).toContain("checked");
    expect(input("heavy")).not.toContain("checked");
    expect(input("environment")).not.toContain("checked");
  });

  it("checks the environment option when the field falls through", () => {
    const html = render();
    const input = (value: string) =>
      html.match(new RegExp(`<input[^>]*value="${value}"[^>]*>`))![0];

    expect(input("environment")).toContain("checked");
    expect(input("standard")).not.toContain("checked");
  });
});
