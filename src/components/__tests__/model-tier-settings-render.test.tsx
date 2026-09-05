import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SettingFieldView } from "@/lib/settings-resolver";
import { ModelTierPanel } from "../model-tier-settings";

/**
 * The provenance half of the settings panel (issue #166). The value in force is
 * only half an answer — an operator debugging a surprising tier needs to see
 * whether it came from this screen or from the deployment, and which variable
 * it would fall back to. That reading is the contract, so it is asserted rather
 * than left to a class-string edit to quietly drop.
 *
 * The panel is presentational — it is handed a resolved field and renders it —
 * so the test hands it one directly. Fetching is `SettingsOverrides`'s job,
 * shared with the lane panel because a tier's model id comes from the lane.
 */

function field(over: Partial<SettingFieldView> = {}): SettingFieldView {
  return {
    key: "modelTierReview",
    label: "Review",
    help: "The tier a review pass runs on.",
    envVar: "AGENT_MODEL_REVIEW",
    options: ["heavy", "standard", "light"],
    source: "environment",
    override: null,
    envValue: "claude-opus-4-8",
    tier: null,
    model: "claude-opus-4-8",
    chooses: ["review"],
    derived: [],
    ...over,
  };
}

function render(over: Partial<SettingFieldView> = {}): string {
  return renderToStaticMarkup(
    <ModelTierPanel
      fields={[field(over)]}
      updatedAt={null}
      busyKey={null}
      disabled={false}
      saveError={null}
      onChoose={() => {}}
    />
  );
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

  it("names the variable that actually supplied the value", () => {
    // Review falls back to the base when its own variable is unset, so the
    // row must say AGENT_MODEL — pointing at a variable the operator would
    // find empty is worse than saying nothing.
    const html = render({ envVar: "AGENT_MODEL" });

    expect(html).toContain("from AGENT_MODEL = claude-opus-4-8");
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

    expect(html).toContain("no model named — the harness picks its own default");
    expect(html).toContain("AGENT_MODEL_REVIEW unset");
  });

  it("names the tier alone when no lane's map could say what it means (issue #226)", () => {
    // An unusable lane file leaves no primary lane to read a model off, so the
    // row says the tier rather than a model from some other map — and rather
    // than reading as if nothing were pinned.
    const html = render({ envValue: "light", model: null, tier: "light" });

    expect(html).toContain("runs light");
    expect(html).not.toContain("runs light (");
    expect(html).not.toContain("no model named");
  });

  it("reads a set ceiling row as a ceiling on the derived pass, not as what it runs", () => {
    // The Review row is a ceiling (issue #201): a review runs one rung above
    // the implement pass, no higher than this. "runs light" would be a lie
    // about a heavy ticket's review, which this row would hold at light but a
    // light ticket's would not reach.
    const html = render({
      source: "override",
      override: "light",
      tier: "light",
      model: "haiku",
      chooses: [],
      derived: [{ kind: "review", rule: "capped", ceiling: "light" }],
    });

    expect(html).toContain("ceiling light on review (haiku)");
    expect(html).not.toContain("runs light (haiku) ·");
    // And what an underived review runs is still named, as the fall-back.
    expect(html).toContain("with no implement tier to derive from, runs light (haiku)");
  });

  it("says the derivation runs free when a ceiling row is unset", () => {
    const html = render({
      envValue: null,
      model: null,
      tier: null,
      chooses: [],
      derived: [{ kind: "review", rule: "free", ceiling: null }],
    });

    expect(html).toContain(
      "no ceiling — review runs one rung above the implement pass"
    );
    expect(html).toContain("no model named — the harness picks its own default");
  });

  it("reads a pinned raw model id on a ceiling row as the answer — a pin names no tier to bound", () => {
    const html = render({
      chooses: [],
      derived: [{ kind: "review", rule: "pinned", ceiling: null }],
    });

    expect(html).toContain("pinned — review runs claude-opus-4-8 and derives nothing");
    expect(html).not.toContain("no ceiling");
  });

  it("reads a lane's default over an unset ceiling row as the fall-back, not the ceiling", () => {
    // On a priced lane an unset field resolves to the lane's default tier
    // (issue #175); that is what an underived review runs, not a bound.
    const html = render({
      envValue: null,
      tier: "standard",
      model: "anthropic/claude-sonnet-4.5",
      chooses: [],
      derived: [{ kind: "review", rule: "free", ceiling: null }],
    });

    expect(html).toContain("no ceiling — review runs one rung above the implement pass");
    expect(html).toContain(
      "with no implement tier to derive from, runs standard (anthropic/claude-sonnet-4.5)"
    );
  });

  it("reads the implement row as the tier the implement pass and its repair run at — a ceiling on nothing", () => {
    // A repair runs at the run's own tier (issue #211), so the row is a
    // chosen tier for both kinds and derives nothing.
    const html = render({
      key: "modelTierImplement",
      label: "Implement",
      envVar: "AGENT_MODEL",
      envValue: "standard",
      tier: "standard",
      model: "sonnet",
      chooses: ["implement", "repair"],
      derived: [],
    });

    expect(html).toContain("runs standard (sonnet)");
    expect(html).not.toContain("on repair");
  });

  it("describes one ceiling row — review — in its opening copy", () => {
    const html = render();

    expect(html).toContain("Review alone is not chosen here but derived");
    expect(html).not.toContain("Review and repair");
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
