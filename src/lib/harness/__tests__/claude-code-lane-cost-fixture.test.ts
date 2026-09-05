import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { readTurnUsage } from "../claude-code/stream-parser";
import {
  chargeForTurn,
  costOverstatement,
  priceTokens,
} from "@/lib/lanes/lane-cost";
import type { TokenPrices } from "@/lib/lanes/lane-config";

/**
 * The evidence behind issue #175's cost rule, kept as the wire actually sent it.
 *
 * Four `result` events captured on 2026-09-02 by running the real Claude Code
 * harness — once against Anthropic direct on the subscription lane, once
 * against OpenRouter's Anthropic-compatible endpoint, and then twice more
 * through OpenRouter with an identical prompt to catch the prompt cache warm.
 * Nothing about any of them was changed but the session id and the final text.
 *
 * They are here because the ticket's central claims are claims about specific
 * observations, and a paraphrase of one in a comment is not a thing a later
 * change can contradict. Together they pin four facts:
 *
 *  1. `modelUsage`, not the sibling `usage`, is the aggregate the CLI charges
 *     from. The subscription turn reports `usage.input_tokens: 10` beside
 *     `modelUsage.inputTokens: 909`, and only the latter reproduces the CLI's
 *     own `total_cost_usd` at Haiku list prices — to the cent.
 *  2. Off an Anthropic-direct endpoint the CLI's dollar figure is fiction: it
 *     billed a turn on a *free* model $0.194985, at $5/$25 per Mtok.
 *  3. The CLI knows it does not know: `costBasis` reads `"list"` on the
 *     first-party model and `"unknown"` on the third-party one. Corroboration
 *     rather than mechanism — the fleet charges from the lane's own declared
 *     prices, which is a fact it controls, not an undocumented field it does
 *     not.
 *  4. Prompt caching survives the skin: the second of the two identical turns
 *     read 21051 tokens from cache and sent 210 fresh, an 8.8x drop. Cache
 *     *writes* are never counted (0, and `null` on the raw API), so they arrive
 *     as ordinary input tokens — which is why an unpriced cache column is
 *     charged at the input rate rather than at zero.
 */

const [
  OPENROUTER_RESULT,
  SUBSCRIPTION_RESULT,
  CACHE_COLD_RESULT,
  CACHE_WARM_RESULT,
] = fs
  .readFileSync(
    path.join(__dirname, "lane-cost-fixture.ndjson"),
    "utf8"
  )
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as Record<string, unknown>);

/** Anthropic's list prices for Haiku 4.5, USD per million tokens. The 1-hour
 * cache write is 2x the base input rate, which is what this turn used. */
const HAIKU_LIST: TokenPrices = {
  inputPerMTok: 1,
  outputPerMTok: 5,
  cacheReadPerMTok: 0.1,
  cacheWritePerMTok: 2,
};

/** GLM 5.3 Flash on OpenRouter, USD per million tokens (2026-09-02 listing) —
 * the lane the smoke test's model belongs to. */
const GLM_FLASH: TokenPrices = {
  inputPerMTok: 0.075,
  outputPerMTok: 0.25,
  cacheReadPerMTok: 0.015,
  cacheWritePerMTok: null,
};

describe("token counts, as the harness reports them", () => {
  it("reads the turn's aggregate from modelUsage, not from the last iteration", () => {
    // The discriminating case: the two disagree on a first-party turn, and
    // pricing the wrong one understates a real bill by 90x on the input column.
    expect(readTurnUsage(SUBSCRIPTION_RESULT)).toEqual({
      inputTokens: 909,
      outputTokens: 61,
      cacheReadTokens: 13979,
      cacheWriteTokens: 6711,
    });
    expect(
      (SUBSCRIPTION_RESULT.usage as Record<string, unknown>).input_tokens
    ).toBe(10);
  });

  it("reproduces the CLI's own cost from those counts, to the cent", () => {
    // Why modelUsage is trusted as the aggregate: applying Haiku list prices
    // to it lands exactly on the figure the CLI put on the wire.
    const usage = readTurnUsage(SUBSCRIPTION_RESULT)!;

    expect(priceTokens(HAIKU_LIST, usage)).toBeCloseTo(
      SUBSCRIPTION_RESULT.total_cost_usd as number,
      6
    );
  });

  it("refuses to charge against `usage`, however tempting a fallback it looks", () => {
    // The trap: `usage` is present on every result and would price *something*,
    // but the fixture above proves it is the last API iteration rather than the
    // turn. Charging a lane's prices against it undercharges by ~90x while
    // looking entirely correct — so a result with no `modelUsage` reports
    // nothing, and the harness's own (over-stating) figure stands instead.
    expect(
      readTurnUsage({ usage: { input_tokens: 5, output_tokens: 7 } })
    ).toBeNull();
  });

  it("reads a result with no counts anywhere as null, not as a free turn", () => {
    expect(readTurnUsage({ type: "result", subtype: "success" })).toBeNull();
  });

  it("reads a shape carrying the field names but no numbers as null", () => {
    // The dangerous near-miss: fields present, values missing. Totalled as
    // zeroes it would look like a legitimate free turn, and a priced lane would
    // charge nothing for a pass that really spent.
    expect(readTurnUsage({ modelUsage: { "some/model": {} } })).toBeNull();
  });

  it("keeps a genuine zero, which is reported as a number", () => {
    // Absent and zero are different facts and only one of them is a price: a
    // turn that really consumed nothing on a column still charges for the rest.
    expect(
      readTurnUsage({ modelUsage: { "m": { inputTokens: 0, outputTokens: 4 } } })
    ).toEqual({
      inputTokens: 0,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("sums every model a turn billed, since subagents bill their own", () => {
    expect(
      readTurnUsage({
        modelUsage: {
          "a": { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 100 },
          "b": { inputTokens: 20, outputTokens: 2 },
        },
      })
    ).toEqual({
      inputTokens: 30,
      outputTokens: 3,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
    });
  });

  it("refuses to charge a lane's prices when nothing was reported", () => {
    // End to end: the unreadable shape reaches `chargeForTurn` and takes the
    // deliberately over-stating branch rather than pricing a $0 turn.
    const charge = chargeForTurn(
      { prices: GLM_FLASH, declaresPrices: true },
      { costUsd: 0.194985, usage: readTurnUsage({ usage: {} }) }
    );

    expect(charge.basis).toBe("harness-unpriced");
    expect(charge.usd).toBe(0.194985);
  });
});

describe("what the two lanes actually cost", () => {
  it("charges the subscription lane exactly what the harness said", () => {
    const charge = chargeForTurn(
      { prices: null, declaresPrices: false },
      {
        costUsd: SUBSCRIPTION_RESULT.total_cost_usd as number,
        usage: readTurnUsage(SUBSCRIPTION_RESULT),
      }
    );

    expect(charge.basis).toBe("harness");
    expect(charge.usd).toBe(0.0160339);
  });

  it("charges the OpenRouter lane its own price, not the CLI's Anthropic one", () => {
    // 38387 input x $5/Mtok + 122 output x $25/Mtok = 0.194985 exactly, which
    // is how we know what the CLI did. The lane's own prices give $0.0029.
    const reported = OPENROUTER_RESULT.total_cost_usd as number;
    expect(38387 * 5e-6 + 122 * 25e-6).toBeCloseTo(reported, 9);

    const charge = chargeForTurn(
      { prices: GLM_FLASH, declaresPrices: true },
      { costUsd: reported, usage: readTurnUsage(OPENROUTER_RESULT) }
    );

    expect(charge.basis).toBe("lane-prices");
    expect(charge.usd).toBeCloseTo(0.0029095, 7);
  });

  it("records the CLI admitting it has no price basis off Anthropic", () => {
    // Corroboration for the rule above, from the CLI's own mouth. Asserted so
    // that a build which starts reporting a real third-party price makes this
    // test fail rather than leaving the fleet deriving one it no longer needs.
    const basis = (u: Record<string, unknown>) =>
      Object.values(u.modelUsage as Record<string, Record<string, unknown>>)[0]
        .costBasis;

    expect(basis(SUBSCRIPTION_RESULT)).toBe("list");
    expect(basis(OPENROUTER_RESULT)).toBe("unknown");
  });

  it("shows the third-party lane emitting no quota telemetry at all", () => {
    // The other half of the ticket: `rate_limit_event` is a subscription
    // construct. The OpenRouter turn carried none, and its result event has no
    // rate-limit field either — so a lane keyed to it has nothing to gate on,
    // permanently, and must never inherit another lane's observation.
    expect(OPENROUTER_RESULT).not.toHaveProperty("rate_limit_info");
    expect(OPENROUTER_RESULT.api_error_status).toBeNull();
  });
});

describe("prompt caching on the lane", () => {
  it("re-reads a cached prefix instead of re-paying for it", () => {
    // Two identical turns, seconds apart. The whole system prompt and tool
    // schema move from fresh input to a cache read — which on a long agentic
    // pass is the dominant cost term, not a detail.
    const cold = readTurnUsage(CACHE_COLD_RESULT)!;
    const warm = readTurnUsage(CACHE_WARM_RESULT)!;

    expect(cold.cacheReadTokens).toBe(0);
    expect(cold.inputTokens).toBe(21261);
    expect(warm.cacheReadTokens).toBe(21051);
    expect(warm.inputTokens).toBe(210);
  });

  it("counts no cache writes at all, so they are charged as input", () => {
    // OpenRouter never reports a cache-write count (0 here; `null` on the raw
    // API) and publishes no cache-write price for this family. The tokens are
    // billed, though — they simply arrive in the input column, which is
    // exactly what `priceTokens` assumes when a cache price is absent.
    for (const result of [CACHE_COLD_RESULT, CACHE_WARM_RESULT]) {
      expect(readTurnUsage(result)!.cacheWriteTokens).toBe(0);
    }
  });

  it("prices the cached turn far below the cold one on the lane's own prices", () => {
    // The economics the lane exists for: a 21k-token prefix at $0.075/Mtok
    // fresh versus $0.015/Mtok cached.
    const cold = priceTokens(GLM_FLASH, readTurnUsage(CACHE_COLD_RESULT)!);
    const warm = priceTokens(GLM_FLASH, readTurnUsage(CACHE_WARM_RESULT)!);

    expect(cold).toBeCloseTo(0.0016, 4);
    expect(warm).toBeCloseTo(0.000342, 6);
    expect(cold / warm).toBeGreaterThan(4);
  });

  it("shows the harness overstating the cached turn by more than 30x", () => {
    // The cheaper the turn really is, the wilder the harness's figure looks:
    // it prices a cache read at a tenth of its own $5/Mtok basis, not at the
    // lane's $0.015.
    const charge = chargeForTurn(
      { prices: GLM_FLASH, declaresPrices: true },
      {
        costUsd: CACHE_WARM_RESULT.total_cost_usd as number,
        usage: readTurnUsage(CACHE_WARM_RESULT),
      }
    );

    expect(charge.basis).toBe("lane-prices");
    expect(costOverstatement(charge)).toBeGreaterThan(30);
  });
});
