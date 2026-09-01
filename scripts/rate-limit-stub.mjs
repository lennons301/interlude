#!/usr/bin/env node
/**
 * Rate-limit stub — a local Anthropic-messages endpoint the Claude Code harness
 * can be pointed at (`ANTHROPIC_BASE_URL`) that returns the
 * `anthropic-ratelimit-unified-*` header family with configurable values
 * (issue #165).
 *
 * Why this exists. Every field of the CLI's `rate_limit_event` is derived from
 * response *headers*, so setting those headers reproduces any limit state on
 * demand — including a rejection — without spending real quota and without
 * waiting for a real wall. It answers the three questions the pause design
 * (#164, #168, #169, #170) rests on: does a rejected headless pass wait or
 * exit, does `rate_limit_event` reach stdout, and is there a negotiated slow
 * mode. It is also a prefactor of #172, which needs base-URL redirection
 * regardless.
 *
 * The CLI has its own internal rate-limit simulator carrying this same scenario
 * vocabulary, but the shipped release compiles its enablement predicate to a
 * constant false, so it cannot be driven from outside — hence this.
 *
 * Deliberately dependency-free (`node:http` only) and single-file, so it can be
 * run on the host, or built into a container on the `interlude` network, with
 * no install step.
 *
 * Usage:
 *   node scripts/rate-limit-stub.mjs --port 4399 --scenario session-limit-reached
 *   ANTHROPIC_BASE_URL=http://127.0.0.1:4399 claude -p ...
 *
 * Point the harness at it with the *subscription* auth path
 * (`CLAUDE_CODE_OAUTH_TOKEN`), not an API key: the unified-window machinery is
 * subscription-gated, and on an API key the CLI emits no `rate_limit_event` at
 * all however the headers are set. Reaching it from an agent container needs
 * `--host 0.0.0.0`, since it binds loopback by default.
 *
 * Live control (no restart needed — a scenario can be switched mid-pass):
 *   POST /__control  {"scenario":"weekly-limit-reached"}
 *   POST /__control  {"headers":{"anthropic-ratelimit-unified-status":"rejected"},"httpStatus":429}
 *   GET  /__requests -> the request log, so "did it wait or exit" is answered
 *                       by counting attempts and their timestamps rather than
 *                       by watching a terminal.
 *   POST /__requests/reset
 *
 * NOTE ON FIDELITY: these headers are Anthropic's, and this reproduces the
 * *shape* the CLI parses, not Anthropic's own behaviour. It also drives the
 * API-key path, whereas the fleet runs on a subscription OAuth token. Findings
 * taken from this stub are provisional — see the findings on issue #165 for
 * which are stub-derived and which were observed against real quota.
 */

import http from "node:http";
import fs from "node:fs";

const HEADER_PREFIX = "anthropic-ratelimit-unified-";
const FIVE_HOURS_S = 5 * 60 * 60;
const SEVEN_DAYS_S = 7 * 24 * 60 * 60;

const now = () => Math.floor(Date.now() / 1000);

/**
 * The scenario table. Names and semantics deliberately mirror the vocabulary
 * the CLI's own (disabled) simulator uses, so a finding recorded against a
 * scenario name here means the same thing to anyone reading the CLI.
 *
 * `status` is the account-wide verdict; `claim` is the limit that tripped,
 * which is what distinguishes a tier-scoped weekly exhaustion (#170's degrade
 * ladder) from an account-wide five-hour rejection (#168's pause).
 */
const SCENARIOS = {
  /** Baseline: allowed, nothing near a limit. */
  normal: () => ({
    httpStatus: 200,
    headers: {
      status: "allowed",
      reset: String(now() + FIVE_HOURS_S),
    },
  }),

  /** Allowed, but the five-hour window is nearly spent — #171's gate input. */
  "approaching-session-limit": () => ({
    httpStatus: 200,
    headers: {
      status: "allowed_warning",
      reset: String(now() + FIVE_HOURS_S),
      "representative-claim": "five_hour",
      "5h-utilization": "88",
      "5h-surpassed-threshold": "80",
    },
  }),

  /** Allowed, but the weekly window is nearly spent. */
  "approaching-weekly-limit": () => ({
    httpStatus: 200,
    headers: {
      status: "allowed_warning",
      reset: String(now() + SEVEN_DAYS_S),
      "representative-claim": "seven_day",
      "7d-utilization": "91",
      "7d-surpassed-threshold": "80",
    },
  }),

  /** Account-wide five-hour rejection: the one state #168 says must pause. */
  "session-limit-reached": () => ({
    httpStatus: 429,
    headers: {
      status: "rejected",
      reset: String(now() + FIVE_HOURS_S),
      "representative-claim": "five_hour",
      "retry-after": String(FIVE_HOURS_S),
    },
  }),

  /** Account-wide weekly rejection. */
  "weekly-limit-reached": () => ({
    httpStatus: 429,
    headers: {
      status: "rejected",
      reset: String(now() + SEVEN_DAYS_S),
      "representative-claim": "seven_day",
      "retry-after": String(SEVEN_DAYS_S),
    },
  }),

  /** Tier-scoped weekly rejection: #170 says step down a tier, do not pause. */
  "opus-limit": () => ({
    httpStatus: 429,
    headers: {
      status: "rejected",
      reset: String(now() + SEVEN_DAYS_S),
      "representative-claim": "seven_day_opus",
      "retry-after": String(SEVEN_DAYS_S),
    },
  }),

  /** Tier-scoped weekly rejection one rung down the ladder. */
  "sonnet-limit": () => ({
    httpStatus: 429,
    headers: {
      status: "rejected",
      reset: String(now() + SEVEN_DAYS_S),
      "representative-claim": "seven_day_sonnet",
      "retry-after": String(SEVEN_DAYS_S),
    },
  }),

  /** Subscription walled but overage billing is picking it up — #173's "an
   * active overage means the account is already spending real money". */
  "overage-active": () => ({
    httpStatus: 200,
    headers: {
      status: "rejected",
      reset: String(now() + FIVE_HOURS_S),
      "representative-claim": "five_hour",
      "overage-status": "allowed",
      "overage-in-use": "true",
      "overage-reset": String(now() + SEVEN_DAYS_S),
      "overage-utilization": "12",
    },
  }),

  /** Overage exhausted too — nothing left to spend. */
  "overage-exhausted": () => ({
    httpStatus: 429,
    headers: {
      status: "rejected",
      reset: String(now() + FIVE_HOURS_S),
      "representative-claim": "five_hour",
      "overage-status": "rejected",
      "overage-disabled-reason": "out_of_credits",
      "overage-reset": String(now() + SEVEN_DAYS_S),
      "retry-after": String(FIVE_HOURS_S),
    },
  }),

  /**
   * The slow-mode header family — what the CLI calls **low-priority mode**: a
   * degraded lane offered instead of a flat rejection, with a stated maximum
   * wait and its own weekly budget.
   *
   * The enum values here are not guesses; they are the ones the shipped binary
   * actually accepts, and getting them wrong is silent. `slow-offer` is an
   * experiment arm (`treatment` | `control`) and anything else is ignored, so a
   * plausible-looking `"true"` reproduces nothing. `slow-status` is one of
   * `active | not_needed | slot_busy | weekly_limit | budget_exhausted |
   * ineligible | off`. `slow-budget-utilization` is clamped to 1 by the parser,
   * so it is a *fraction*, not a percentage.
   */
  "slow-offer": () => ({
    httpStatus: 429,
    headers: {
      status: "rejected",
      reset: String(now() + FIVE_HOURS_S),
      "representative-claim": "five_hour",
      "slow-offer": "treatment",
      "slow-status": "active",
      "slow-max-wait": "120",
      "slow-retry-after": "30",
      "slow-budget-utilization": "0.4",
      "slow-budget-reset": String(now() + SEVEN_DAYS_S),
      "retry-after": String(FIVE_HOURS_S),
    },
  }),
};

function parseArgs(argv) {
  // 127.0.0.1 by default: this answers unauthenticated requests and echoes
  // whatever limit state it is told to, so it may not become reachable on every
  // interface just because someone forgot a flag. `--host 0.0.0.0` is what the
  // container-on-the-interlude-network usage needs.
  const out = { port: 4399, host: "127.0.0.1", scenario: "normal", log: null };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inlineValue] = argv[i].split("=");
    const value = inlineValue ?? argv[i + 1];
    const consume = () => {
      if (inlineValue === undefined) i++;
    };
    if (flag === "--port") { out.port = Number(value); consume(); }
    else if (flag === "--host") { out.host = value; consume(); }
    else if (flag === "--scenario") { out.scenario = value; consume(); }
    else if (flag === "--log") { out.log = value; consume(); }
    else if (flag === "--help" || flag === "-h") { out.help = true; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(
    `rate-limit-stub — see the header comment in this file.\n\n` +
      `  --port <n>        listen port (default 4399)\n` +
      `  --host <addr>     listen address (default 127.0.0.1; use 0.0.0.0 to\n` +
      `                    reach it from an agent container)\n` +
      `  --scenario <name> initial scenario (default normal)\n` +
      `  --log <path>      also append a JSONL request log here\n\n` +
      `scenarios: ${Object.keys(SCENARIOS).join(", ")}\n`
  );
  process.exit(0);
}

if (!SCENARIOS[args.scenario]) {
  console.error(
    `unknown scenario "${args.scenario}"; known: ${Object.keys(SCENARIOS).join(", ")}`
  );
  process.exit(2);
}

/** Current response policy. A scenario is expanded to headers at *request*
 * time, not at switch time, so every `reset` is relative to the attempt the
 * harness actually made — a stub whose reset drifts into the past mid-run would
 * answer the wait-vs-exit question wrongly. */
let policy = { scenario: args.scenario, headers: null, httpStatus: null };

/** Every request the harness made, so retry/wait behaviour is measurable after
 * the fact rather than only observable live. */
const requestLog = [];

function currentResponse() {
  const base = SCENARIOS[policy.scenario]();
  const headers = { ...base.headers };
  for (const [key, value] of Object.entries(policy.headers ?? {})) {
    const bare = key.toLowerCase().startsWith(HEADER_PREFIX)
      ? key.toLowerCase().slice(HEADER_PREFIX.length)
      : key.toLowerCase();
    if (value === null) delete headers[bare];
    else headers[bare] = String(value);
  }
  return {
    httpStatus: policy.httpStatus ?? base.httpStatus,
    headers,
  };
}

/** Bare scenario keys become real header names here, in one place: `retry-after`
 * is a standard HTTP header and must NOT carry the unified prefix, everything
 * else must. */
function wireHeaders(headers) {
  const out = {};
  for (const [bare, value] of Object.entries(headers)) {
    out[bare === "retry-after" ? "retry-after" : HEADER_PREFIX + bare] = String(value);
  }
  return out;
}

function record(entry) {
  requestLog.push(entry);
  if (args.log) {
    fs.appendFileSync(args.log, JSON.stringify(entry) + "\n");
  }
  const sinceStart = ((entry.atMs - startedAtMs) / 1000).toFixed(1);
  console.log(
    `[stub] +${sinceStart}s #${requestLog.length} ${entry.method} ${entry.path} ` +
      `-> ${entry.httpStatus} (${entry.scenario})`
  );
}

/**
 * Read a request body, resolving with whatever arrived even if the client hung
 * up mid-send. An abandoned request must still reach `record()`: the request log
 * is the instrument that answers "did the pass wait or exit", and a harness that
 * gives up on a rejected call is precisely the behaviour under test — so
 * dropping those requests would delete the evidence.
 */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString());
    };
    req.on("data", (c) => chunks.push(c));
    req.on("end", done);
    req.on("aborted", done);
    req.on("error", done);
    req.on("close", done);
  });
}

function sseEvent(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** A minimal but well-formed Anthropic streaming response, so a 200 scenario
 * gets the harness all the way to a terminal `result` rather than failing on a
 * malformed body and confusing "the limit allowed it" with "the stub broke". */
function writeStreamedMessage(res, model) {
  res.write(
    sseEvent("message_start", {
      type: "message_start",
      message: {
        id: "msg_stub",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 1 },
      },
    })
  );
  res.write(
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    })
  );
  res.write(
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "STUB-OK" },
    })
  );
  res.write(sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }));
  res.write(
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 4 },
    })
  );
  res.write(sseEvent("message_stop", { type: "message_stop" }));
  res.end();
}

function nonStreamedMessage(model) {
  return {
    id: "msg_stub",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: "STUB-OK" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 8, output_tokens: 4 },
  };
}

const startedAtMs = Date.now();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://stub");
  const body = await readBody(req);

  // --- control plane -------------------------------------------------------
  if (url.pathname === "/__control" && req.method === "POST") {
    let requested;
    try {
      requested = JSON.parse(body || "{}");
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "body is not JSON" }));
      return;
    }
    if (requested.scenario && !SCENARIOS[requested.scenario]) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: `unknown scenario "${requested.scenario}"`,
          known: Object.keys(SCENARIOS),
        })
      );
      return;
    }
    if (requested.scenario) policy.scenario = requested.scenario;
    if ("headers" in requested) policy.headers = requested.headers;
    if ("httpStatus" in requested) policy.httpStatus = requested.httpStatus;
    console.log(`[stub] policy -> ${JSON.stringify(policy)}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, policy, effective: currentResponse() }));
    return;
  }

  if (url.pathname === "/__requests" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        {
          count: requestLog.length,
          startedAtMs,
          requests: requestLog,
        },
        null,
        2
      )
    );
    return;
  }

  if (url.pathname === "/__requests/reset" && req.method === "POST") {
    requestLog.length = 0;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // --- data plane ----------------------------------------------------------
  const { httpStatus, headers } = currentResponse();
  let parsedBody = null;
  try {
    parsedBody = body ? JSON.parse(body) : null;
  } catch {
    // Not JSON — logged verbatim below; the request still gets an answer.
  }
  const model = parsedBody?.model ?? "claude-stub";
  const wantsStream = parsedBody?.stream === true;

  record({
    at: new Date().toISOString(),
    atMs: Date.now(),
    method: req.method,
    path: url.pathname + (url.search || ""),
    scenario: policy.scenario,
    httpStatus,
    model,
    stream: wantsStream,
    // Verbatim, minus the credential: the point of the log is evidence, and a
    // token in an evidence file outlives the experiment.
    requestHeaders: Object.fromEntries(
      Object.entries(req.headers).filter(
        ([k]) => !/authorization|x-api-key|cookie/i.test(k)
      )
    ),
    bodyBytes: body.length,
  });

  const wire = { ...wireHeaders(headers), "request-id": `stub-${requestLog.length}` };

  // The request is logged above whether or not it is still answerable; writing
  // to a socket the client already abandoned would throw and take the whole
  // server down with it, and the evidence is already safe.
  if (res.destroyed || res.writableEnded) return;

  if (httpStatus !== 200) {
    res.writeHead(httpStatus, { ...wire, "content-type": "application/json" });
    res.end(
      JSON.stringify({
        type: "error",
        error: {
          type: httpStatus === 429 ? "rate_limit_error" : "api_error",
          message:
            httpStatus === 429
              ? "stub: rate limit exceeded"
              : `stub: http ${httpStatus}`,
        },
      })
    );
    return;
  }

  if (wantsStream) {
    res.writeHead(200, {
      ...wire,
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    writeStreamedMessage(res, model);
    return;
  }

  res.writeHead(200, { ...wire, "content-type": "application/json" });
  res.end(JSON.stringify(nonStreamedMessage(model)));
});

server.listen(args.port, args.host, () => {
  console.log(
    `[stub] listening on http://${args.host}:${args.port} scenario=${args.scenario}\n` +
      `[stub] point the harness at it with ANTHROPIC_BASE_URL=http://${args.host}:${args.port}`
  );
});
