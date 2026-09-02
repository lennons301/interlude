import { describe, expect, it } from "vitest";
import { RATE_LIMIT_TYPES } from "../rate-limit-event";
import { limitScopeTier, planTierDegrade } from "../tier-ladder";
import { MODEL_TIERS, type ModelTier } from "../../model-tiers";

/**
 * The ladder's two rules (issue #170), pinned separately from the reducer that
 * expresses the decision: which windows are tier-scoped, and which rung a
 * rejection on one lands the run on.
 *
 * The failure this guards against is quiet in both directions. Read a
 * tier-scoped window as account-wide and the fleet waits out a seven-day
 * window it did not have to; read an account-wide one as tier-scoped and it
 * spends a second refused pass to learn nothing.
 */

describe("limitScopeTier — which windows name a tier", () => {
  it.each([
    ["seven_day_opus", "heavy"],
    ["seven_day_sonnet", "standard"],
  ] as const)("%s is scoped to the %s tier", (limitType, tier) => {
    expect(limitScopeTier(limitType)).toBe(tier);
  });

  it.each([
    "five_hour",
    "seven_day",
    "seven_day_overage_included",
    "overage",
  ])("%s is account-wide", (limitType) => {
    expect(limitScopeTier(limitType)).toBeNull();
  });

  it("covers every limit type this build knows, one way or the other", () => {
    // The list in rate-limit-event.ts is the vocabulary; this asserts the
    // ladder has an answer for all of it, so a member added there without a
    // thought here shows up as a failure rather than as silent account-wide
    // behaviour.
    const scoped = RATE_LIMIT_TYPES.filter((t) => limitScopeTier(t) !== null);
    expect(scoped).toEqual(["seven_day_opus", "seven_day_sonnet"]);
  });

  it("understands a tier-scoped window a later CLI adds", () => {
    // Derived from the CLI's `<window>_<model alias>` naming rather than
    // enumerated, so `seven_day_haiku` needs no code change to be read — the
    // whole reason the trailing segment goes through the same normaliser a
    // ticket's `model:` directive does.
    expect(limitScopeTier("seven_day_haiku")).toBe("light");
    expect(limitScopeTier("five_hour_opus")).toBe("heavy");
    expect(limitScopeTier("seven_day_standard")).toBe("standard");
  });

  it("reads a window naming nothing it knows as account-wide", () => {
    // The cautious answer, which is the point: a member we cannot interpret
    // pauses the run rather than degrading it on a guess.
    expect(limitScopeTier("thirty_day_enterprise")).toBeNull();
    expect(limitScopeTier("")).toBeNull();
  });
});

describe("planTierDegrade — which rung the retry lands on", () => {
  it("steps one rung down from the tier that ran", () => {
    expect(planTierDegrade("heavy", "seven_day_opus")).toEqual({
      from: "heavy",
      to: "standard",
    });
    expect(planTierDegrade("standard", "seven_day_sonnet")).toEqual({
      from: "standard",
      to: "light",
    });
  });

  it("never steps onto a rung the exhausted window already covers", () => {
    // A `seven_day_sonnet` wall observed on a heavy pass: standard is spent
    // too, so stepping heavy -> standard would walk straight back into the
    // window that just refused. The first rung below *both* is light.
    expect(planTierDegrade("heavy", "seven_day_sonnet")).toEqual({
      from: "heavy",
      to: "light",
    });
  });

  it("has no step at the bottom of the ladder", () => {
    expect(planTierDegrade("light", "seven_day_haiku")).toBeNull();
    // Nor when the window names the bottom rung and the pass ran above it.
    expect(planTierDegrade("heavy", "seven_day_haiku")).toBeNull();
  });

  it.each(["five_hour", "seven_day", "overage", "thirty_day_enterprise"])(
    "has no step for %s, which names no tier",
    (limitType) => {
      for (const tier of MODEL_TIERS) {
        expect(planTierDegrade(tier, limitType)).toBeNull();
      }
    }
  );

  it("has no step when the pass ran at no known tier", () => {
    // A deployment pinning a raw model id, or naming none at all. There is no
    // rung to step off, and inventing one would override a pin an operator set
    // deliberately.
    expect(planTierDegrade(null, "seven_day_opus")).toBeNull();
  });

  it("walks the ladder down and then stops, whatever refuses it", () => {
    // The bound the run's accounting rests on: `runs.model` only ever moves
    // downward, so a run can degrade at most twice before the next wall has to
    // pause it. Nothing else caps the retries.
    let tier: ModelTier | null = "heavy";
    const walked: ModelTier[] = [tier];
    for (let i = 0; i < 10 && tier !== null; i++) {
      const step = planTierDegrade(tier, "seven_day_opus");
      tier = step?.to ?? null;
      if (tier) walked.push(tier);
    }
    expect(walked).toEqual(["heavy", "standard", "light"]);
  });
});
