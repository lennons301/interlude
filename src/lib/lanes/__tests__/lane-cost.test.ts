import { describe, it, expect } from "vitest";
import {
  chargeForTurn,
  costOverstatement,
  priceTokens,
  type TurnTokenUsage,
} from "../lane-cost";
import type { TokenPrices } from "../lane-config";

/**
 * What a turn costs, decided by the lane (issue #175).
 *
 * The numbers in the first two tests are not invented: they are the two turns
 * measured on 2026-09-02, one through OpenRouter's Anthropic-compatible
 * endpoint and one against Anthropic direct. They are the evidence for the
 * whole rule — "the harness's dollar figure is meaningless off an
 * Anthropic-direct endpoint" — so they are pinned here rather than paraphrased
 * in a comment.
 */

/** GLM 5.3 Flash on OpenRouter, USD per million tokens (2026-09-02 listing). */
const GLM_FLASH: TokenPrices = {
  inputPerMTok: 0.075,
  outputPerMTok: 0.25,
  cacheReadPerMTok: 0.015,
  cacheWritePerMTok: null,
};

function usage(over: Partial<TurnTokenUsage> = {}): TurnTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...over,
  };
}

describe("chargeForTurn", () => {
  it("takes the harness's figure on a lane that declares no prices", () => {
    // An Anthropic-direct lane: the CLI prices a model it recognises at that
    // model's list rates and says so (costBasis: "list"). Re-deriving it here
    // would only be a second copy to fall out of date.
    const charge = chargeForTurn(
      { prices: null },
      { costUsd: 0.0160339, usage: usage({ inputTokens: 909 }) }
    );

    expect(charge).toEqual({
      usd: 0.0160339,
      basis: "harness",
      reportedUsd: 0.0160339,
    });
  });

  it("derives the charge from the lane's prices, ignoring the harness's claim", () => {
    // The measured turn: 38387 in / 122 out through OpenRouter. The CLI
    // reported $0.194985, having applied $5/$25 per Mtok — Anthropic list
    // rates — to a model the endpoint had never billed at those rates.
    const charge = chargeForTurn(
      { prices: GLM_FLASH },
      {
        costUsd: 0.194985,
        usage: usage({ inputTokens: 38387, outputTokens: 122 }),
      }
    );

    expect(charge.basis).toBe("lane-prices");
    expect(charge.usd).toBeCloseTo(0.0029095, 7);
    // The harness's number survives beside it: a surprising bill has to be
    // debuggable from the feed, not from a re-run.
    expect(charge.reportedUsd).toBe(0.194985);
    // Two orders of magnitude. This is the difference between "the cheap lane
    // works" and "the cheap lane blew the attempt budget".
    expect(costOverstatement(charge)).toBeCloseTo(67, 0);
  });

  it("keeps the harness's overstatement when a turn reported no tokens", () => {
    // A killed container or a lost stream leaves nothing to price. The harness
    // figure stands, knowingly: this is a money guard, and over-reporting stops
    // work early while under-reporting spends money nobody authorised.
    const charge = chargeForTurn(
      { prices: GLM_FLASH },
      { costUsd: 0.194985, usage: null }
    );

    expect(charge).toEqual({
      usd: 0.194985,
      basis: "harness-unpriced",
      reportedUsd: 0.194985,
    });
    // Nothing to compare, so nothing is claimed.
    expect(costOverstatement(charge)).toBeNull();
  });

  it("charges a genuinely free lane nothing, rather than the harness's fiction", () => {
    // The turn that proved the point ran on a free model and was billed
    // $0.194985 by the CLI. Zero is a legal price, and reading it as "unpriced"
    // would send the fleet straight back to that number.
    const charge = chargeForTurn(
      {
        prices: {
          inputPerMTok: 0,
          outputPerMTok: 0,
          cacheReadPerMTok: null,
          cacheWritePerMTok: null,
        },
      },
      {
        costUsd: 0.194985,
        usage: usage({ inputTokens: 38387, outputTokens: 122 }),
      }
    );

    expect(charge.usd).toBe(0);
    expect(charge.basis).toBe("lane-prices");
    // A zero charge has no ratio to report.
    expect(costOverstatement(charge)).toBeNull();
  });
});

describe("priceTokens", () => {
  it("prices all four token columns apart", () => {
    const cost = priceTokens(
      {
        inputPerMTok: 1,
        outputPerMTok: 5,
        cacheReadPerMTok: 0.1,
        cacheWritePerMTok: 2,
      },
      usage({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      })
    );

    expect(cost).toBeCloseTo(1 + 5 + 0.1 + 2, 10);
  });

  it("charges an unpriced cache column at the input rate, not at zero", () => {
    // OpenRouter publishes no cache-write price on the GLM family. That means
    // "no discount", not "free" — reading it as free would understate spend on
    // exactly the lanes where spend is real money.
    const cost = priceTokens(GLM_FLASH, usage({ cacheWriteTokens: 1_000_000 }));

    expect(cost).toBeCloseTo(GLM_FLASH.inputPerMTok, 10);
  });

  it("applies the cache-read discount where the provider publishes one", () => {
    // The column that dominates a long agentic pass: a cache read is 5x cheaper
    // than fresh input here, so getting it wrong misprices the whole run.
    const cost = priceTokens(GLM_FLASH, usage({ cacheReadTokens: 1_000_000 }));

    expect(cost).toBeCloseTo(0.015, 10);
  });
});
