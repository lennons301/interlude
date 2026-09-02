import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { readTurnUsage } from "../output-parser";
import { chargeForTurn, priceTokens } from "@/lib/lanes/lane-cost";
import type { TokenPrices } from "@/lib/lanes/lane-config";

/**
 * The evidence behind issue #175's cost rule, kept as the wire actually sent it.
 *
 * Two `result` events captured on 2026-09-02 by running the real Claude Code
 * harness twice — once against Anthropic direct on the subscription lane, once
 * against OpenRouter's Anthropic-compatible endpoint — and nothing else about
 * either was changed but the session id and the final text.
 *
 * They are here because the ticket's central claim is a claim about a specific
 * observation, and a paraphrase of it in a comment is not a thing a later
 * change can contradict. Together they pin three facts:
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
 */

const [OPENROUTER_RESULT, SUBSCRIPTION_RESULT] = fs
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

  it("falls back to `usage` for a result that carries no modelUsage", () => {
    // Not a shape either capture has, but one a differently-versioned harness
    // could: better a slightly coarser count than no charge at all.
    expect(
      readTurnUsage({ usage: { input_tokens: 5, output_tokens: 7 } })
    ).toEqual({
      inputTokens: 5,
      outputTokens: 7,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("reads a result with no counts anywhere as null, not as a free turn", () => {
    expect(readTurnUsage({ type: "result", subtype: "success" })).toBeNull();
  });
});

describe("what the two lanes actually cost", () => {
  it("charges the subscription lane exactly what the harness said", () => {
    const charge = chargeForTurn(
      { prices: null },
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
      { prices: GLM_FLASH },
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
