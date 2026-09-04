#!/usr/bin/env node
/**
 * OpenRouter lane check — does a third-party Anthropic-compatible endpoint
 * actually behave the way the lane design assumes (issue #175)?
 *
 * Why this exists. Issue #164 justified shipping a single harness adapter on
 * the grounds that Kimi, GLM and MiniMax expose Anthropic-compatible endpoints,
 * so switching provider is a base-URL plus token plus model-id change. That
 * reasoning is only as good as the last time somebody checked it against a live
 * provider — and two of the assumptions under it turned out to be false the
 * first time anyone did (see the findings recorded on issue #175: the CLI's
 * reported cost is Anthropic list prices applied to a model that was never
 * billed at them, and there is no rate-limit telemetry at all).
 *
 * So this is the standing probe. It answers, in one command and for a few
 * hundredths of a cent, the questions the lane's correctness rests on:
 *
 *   1. Does the Anthropic Messages skin answer at all, with an Anthropic-shaped
 *      response? (`--check skin`)
 *   2. Does prompt caching work through it, and does the endpoint report cache
 *      reads and cache *writes*? (`--check cache` — sends the same cacheable
 *      prefix twice, and audits each response against OpenRouter's
 *      `GET /v1/generation` record: the billed truth, which also names the
 *      upstream host that served the request. Issue #193's lesson: the skin's
 *      `usage` block alone cannot distinguish "this model does not cache" from
 *      "OpenRouter routed my two probes to two different hosts" — a first
 *      reading of `cache_read: 0` on GLM was the latter, and the model caches
 *      fine.)
 *   3. Does the endpoint emit any `anthropic-ratelimit-*` header? (Every check
 *      reports this: it is the fact `quota_state` being per-lane rests on.)
 *
 * It deliberately does NOT run the Claude Code harness — that needs the harness
 * installed and a workspace, and the point here is to isolate the *endpoint's*
 * behaviour from the harness's. For the harness half, run a real pass on the
 * lane and read `modelUsage` off the result event.
 *
 * Dependency-free (global `fetch`), like `rate-limit-stub.mjs`, so it runs on
 * the host or in a container with no install step.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... node scripts/openrouter-lane-check.mjs
 *   OPENROUTER_API_KEY=... node scripts/openrouter-lane-check.mjs \
 *     --model z-ai/glm-5.3-flash --check all
 *
 * The key is read from the environment by *name*, exactly as the lane declares
 * it, and is never printed. A `402 billing_error` means the OpenRouter account
 * has no credits: free-suffixed models (`:free`) still work, which is enough to
 * answer questions 1 and 3 but tells you nothing about price.
 */

const ANTHROPIC_VERSION = "2023-06-01";

/** The lane's own base URL. Not `/api/v1`: the Anthropic path is appended. */
const DEFAULT_BASE_URL = "https://openrouter.ai/api";

/** A model that costs nothing, so the probe is runnable on an account with no
 * credits. Override with --model to check the one a lane actually maps. */
const DEFAULT_MODEL = "minimax/minimax-m2.7:free";

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.ANTHROPIC_BASE_URL ?? DEFAULT_BASE_URL,
    model: DEFAULT_MODEL,
    check: "all",
    envVar: "OPENROUTER_API_KEY",
  };
  const takesValue = new Set(["--base-url", "--model", "--check", "--env-var"]);
  const keys = {
    "--base-url": "baseUrl",
    "--model": "model",
    "--check": "check",
    "--env-var": "envVar",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!takesValue.has(flag)) {
      console.error(`unknown flag ${flag}`);
      process.exit(2);
    }
    // Advance one at a time, so a flag left without a value is reported rather
    // than swallowing the next flag as its argument.
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      console.error(`${flag} needs a value`);
      process.exit(2);
    }
    args[keys[flag]] = value;
    i += 1;
  }
  return args;
}

async function call(args, key, body) {
  const response = await fetch(`${args.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      // The lane's auth shape: Claude Code sends ANTHROPIC_AUTH_TOKEN as a
      // bearer token, and deliberately sets no x-api-key.
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Left as null; the raw text is reported instead.
  }
  const rateLimitHeaders = [...response.headers]
    .filter(([name]) => name.startsWith("anthropic-ratelimit"))
    .map(([name, value]) => `${name}: ${value}`);
  return { status: response.status, json, text, rateLimitHeaders };
}

/**
 * OpenRouter's audit record for one response — what was actually billed, and
 * by which upstream host. This is the ground truth the skin's `usage` block is
 * a lossy view of: `provider_name` exposes the fan-out across a slug's ~20
 * hosts (the cache-miss and rate-spread mechanism of issue #193), and
 * `cache_discount` is the money the cache actually saved. Returns null off
 * OpenRouter, or if the record never appears; the record lags the response by
 * a second or two, hence the retry.
 */
async function fetchGeneration(args, key, id) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const response = await fetch(`${args.baseUrl}/v1/generation?id=${id}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    if (response.status === 200) {
      return (await response.json()).data;
    }
  }
  return null;
}

function reportQuotaHeaders(result) {
  if (result.rateLimitHeaders.length > 0) {
    console.log("  quota headers:", result.rateLimitHeaders.join("; "));
    console.log(
      "  -> this endpoint DOES report a unified window; a lane keyed to it can " +
        "carry quota state."
    );
  } else {
    console.log(
      "  quota headers: none — no `anthropic-ratelimit-*` header on the response."
    );
    console.log(
      "  -> the harness will emit no `rate_limit_event`, so this lane has no " +
        "quota state, permanently. It is bounded by spend (issue #175)."
    );
  }
}

async function checkSkin(args, key) {
  console.log(`\n== skin: does ${args.baseUrl}/v1/messages speak Anthropic? ==`);
  const result = await call(args, key, {
    model: args.model,
    max_tokens: 32,
    messages: [{ role: "user", content: "Reply with exactly: SKIN OK" }],
  });

  console.log(`  HTTP ${result.status}`);
  if (result.status !== 200) {
    console.log(`  error: ${result.text.slice(0, 400)}`);
    reportQuotaHeaders(result);
    return false;
  }

  const shaped =
    result.json?.type === "message" && Array.isArray(result.json?.content);
  console.log(`  Anthropic-shaped response: ${shaped ? "yes" : "NO"}`);
  console.log(
    `  content block types: ${(result.json?.content ?? [])
      .map((block) => block.type)
      .join(", ") || "none"}`
  );
  console.log(`  usage: ${JSON.stringify(result.json?.usage ?? null)}`);
  reportQuotaHeaders(result);
  return shaped;
}

async function checkCache(args, key) {
  console.log("\n== cache: is a cacheable prefix actually re-read? ==");
  // Long enough to clear any provider's minimum cacheable prefix.
  const prefix = "The quick brown fox jumps over the lazy dog. ".repeat(400);
  const body = {
    model: args.model,
    max_tokens: 16,
    system: [
      { type: "text", text: prefix, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: "Say A" }],
  };

  const hosts = [];
  for (const attempt of [1, 2]) {
    const result = await call(args, key, body);
    if (result.status !== 200) {
      console.log(`  attempt ${attempt}: HTTP ${result.status} — ${result.text.slice(0, 200)}`);
      return false;
    }
    const usage = result.json.usage ?? {};
    console.log(
      `  attempt ${attempt}: input=${usage.input_tokens} ` +
        `cache_read=${usage.cache_read_input_tokens} ` +
        `cache_write=${usage.cache_creation_input_tokens}`
    );
    const generation = await fetchGeneration(args, key, result.json.id);
    if (generation !== null) {
      hosts.push(generation.provider_name);
      console.log(
        `    billed: host=${generation.provider_name} ` +
          `cost=$${generation.total_cost} ` +
          `cached=${generation.native_tokens_cached}/${generation.native_tokens_prompt} ` +
          `cache_discount=${generation.cache_discount}`
      );
    } else {
      console.log("    billed: no generation record (not OpenRouter?)");
    }
    if (attempt === 2) {
      const read = usage.cache_read_input_tokens ?? 0;
      if (read > 0) {
        console.log(
          "  -> caching works through the skin; the lane's cache_read price applies."
        );
      } else if (hosts.length === 2 && hosts[0] !== hosts[1]) {
        console.log(
          `  -> no cache read, but the probes were served by two DIFFERENT hosts ` +
            `(${hosts[0]}, ${hosts[1]}) — a routing miss, not evidence the model ` +
            "cannot cache (issue #193). Re-run before concluding anything."
        );
      } else {
        console.log(
          "  -> NO cache read on an identical prefix on one host. Every turn " +
            "re-pays full input price for the whole context, which dominates " +
            "a long pass."
        );
      }
      // Null on OpenRouter today; undefined on a provider that omits the field
      // entirely. Both mean the same thing: no cache-write count to price.
      if (usage.cache_creation_input_tokens == null) {
        console.log(
          "  -> cache *writes* are not reported (null, not a count). They arrive " +
            "as ordinary input tokens, which is how the lane prices them."
        );
      }
    }
  }
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const key = process.env[args.envVar];
  if (!key) {
    console.error(
      `${args.envVar} is not set. The lane names the variable, never the secret ` +
        "— export it and re-run."
    );
    process.exit(2);
  }

  console.log(`model: ${args.model}`);
  console.log(`base URL: ${args.baseUrl}`);

  let ok = true;
  if (args.check === "all" || args.check === "skin") {
    ok = (await checkSkin(args, key)) && ok;
  }
  if (args.check === "all" || args.check === "cache") {
    ok = (await checkCache(args, key)) && ok;
  }
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
