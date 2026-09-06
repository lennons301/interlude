#!/usr/bin/env node
/**
 * Codex stub — a local OpenAI Responses endpoint the Codex CLI can be pointed
 * at (through a `model_providers` entry in its `config.toml`) that plays a
 * scripted turn or refuses with a chosen 429 shape (issue #221).
 *
 * Why this exists. The Codex adapter's fixtures are recordings of the *real*
 * CLI's `codex exec --json` output, and what the CLI prints is a function of
 * what the model endpoint answers. This serves those answers: a turn that runs
 * a shell command, applies a patch and finishes with a message; an API-key
 * rate limit (429 `rate_limit_exceeded`); and a ChatGPT-plan usage wall (429
 * `usage_limit_reached`), which the CLI phrases in its own words. So the
 * fixtures under `src/lib/harness/__tests__/codex-*.ndjson` can be
 * re-recorded on demand against any CLI version, without spending real quota
 * and without waiting for a real wall — the same job `rate-limit-stub.mjs`
 * does for the Claude Code harness.
 *
 * Deliberately dependency-free (`node:http` only) and single-file.
 *
 * Usage — record the success fixture with the CLI version the image installs:
 *
 *   node scripts/codex-responses-stub.mjs --port 8787 --scenario success &
 *   mkdir -p /tmp/codex-home && cat > /tmp/codex-home/config.toml <<'EOF'
 *   model_provider = "interlude"
 *   [model_providers.interlude]
 *   name = "Interlude stub"
 *   base_url = "http://127.0.0.1:8787/v1"
 *   env_key = "CODEX_STUB_KEY"
 *   wire_api = "responses"
 *   EOF
 *   cd "$(mktemp -d)" && git init -q
 *   printf '%s' "Write pong into pong.txt, add notes/pong.md, then report." \
 *     | CODEX_HOME=/tmp/codex-home CODEX_STUB_KEY=stub-key \
 *       npx -y @openai/codex@0.153.4 exec --json --skip-git-repo-check \
 *         --dangerously-bypass-approvals-and-sandbox -c features.plugins=false \
 *         -m gpt-5.4 -c 'model_reasoning_effort="medium"' - \
 *     > codex-stream-fixture.ndjson
 *
 * Then `--scenario rate-limit` and `--scenario usage-limit` for the two
 * refusal fixtures, and `codex exec resume <thread id> …` against
 * `--scenario message` for the resume fixture (which is what showed that the
 * CLI's `turn.completed.usage` is the thread's running total, not the turn's).
 *
 * Scenarios:
 *   message      one agent message ("pong"), usage 100 in / 5 out
 *   success      call 1: a shell command (`exec_command` when the CLI offers
 *                it, else `shell`); call 2: an `apply_patch` custom tool call;
 *                call 3: the final message. Each call reports distinct usage
 *                (1200/40, 1400/60, 1500/30) so the recording shows whether
 *                the CLI sums them (it does: 4100/130).
 *   rate-limit   HTTP 429 with an API-shaped `rate_limit_exceeded` body and a
 *                `retry-after` header, on every call
 *   usage-limit  HTTP 429 with a ChatGPT-shaped `usage_limit_reached` body
 *                (`resets_in_seconds`, `resets_at` three hours out), on every
 *                call
 *
 * GET /__requests returns the request log (method, path, bearer, body), so
 * "which tool did the CLI offer" and "how many times did it retry" are read
 * off the log rather than guessed.
 *
 * NOTE ON FIDELITY: this reproduces the *shape* of the Responses wire the CLI
 * parses, not OpenAI's behaviour. Recordings made against it are the CLI's
 * real output for those answers; what a real ChatGPT wall or a real API 429
 * says on the day is the proof ticket's (#224) to confirm.
 */

import http from "node:http";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const port = Number(flag("port", process.env.PORT ?? "8787"));
const host = flag("host", "127.0.0.1");
const scenario = flag("scenario", process.env.SCENARIO ?? "message");

const requests = [];
let calls = 0;

const usage = (input, cached, output, reasoning) => ({
  input_tokens: input,
  input_tokens_details: { cached_tokens: cached },
  output_tokens: output,
  output_tokens_details: { reasoning_tokens: reasoning },
  total_tokens: input + output,
});

const message = (text) => ({
  type: "message",
  id: `msg_${calls}`,
  status: "completed",
  role: "assistant",
  content: [{ type: "output_text", text, annotations: [] }],
});

/** The SSE frames of one completed response carrying `items`. */
function completed(items, u) {
  const id = `resp_${calls}`;
  const events = [
    { type: "response.created", response: { id, object: "response", status: "in_progress", output: [] } },
  ];
  items.forEach((item, i) => {
    events.push({ type: "response.output_item.added", output_index: i, item: { ...item, status: "in_progress" } });
    if (item.type === "message") {
      events.push({
        type: "response.output_text.delta",
        output_index: i,
        content_index: 0,
        item_id: item.id,
        delta: item.content[0].text,
      });
    }
    events.push({ type: "response.output_item.done", output_index: i, item });
  });
  events.push({
    type: "response.completed",
    response: { id, object: "response", status: "completed", output: items, usage: u },
  });
  return events;
}

function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

function refuse(res, status, headers, body) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const SHELL_COMMAND = "printf 'pong\\n' > pong.txt && cat pong.txt";
const PATCH = "*** Begin Patch\n*** Add File: notes/pong.md\n+# pong\n+\n+Written by the recording run.\n*** End Patch\n";

function answer(request, res) {
  const toolNames = (request.tools ?? []).map((tool) => tool.name);
  const input = request.input ?? [];
  const outputs = input.filter(
    (item) => item.type === "function_call_output" || item.type === "custom_tool_call_output"
  ).length;

  switch (scenario) {
    case "rate-limit":
      return refuse(res, 429, { "retry-after": "1" }, {
        error: {
          message:
            "Rate limit reached for gpt-5.4 in organization org-stub on tokens per min (TPM): " +
            "Limit 30000, Used 30000, Requested 512. Please try again in 1.024s. " +
            "Visit https://platform.openai.com/account/rate-limits to learn more.",
          type: "tokens",
          param: null,
          code: "rate_limit_exceeded",
        },
      });
    case "usage-limit": {
      const resetsInSeconds = 3 * 3600;
      return refuse(res, 429, {}, {
        error: {
          type: "usage_limit_reached",
          message: "The usage limit has been reached",
          plan_type: "plus",
          resets_in_seconds: resetsInSeconds,
          resets_at: Math.floor(Date.now() / 1000) + resetsInSeconds,
        },
      });
    }
    case "success": {
      if (outputs === 0) {
        const call = toolNames.includes("shell")
          ? { name: "shell", arguments: { command: ["bash", "-lc", SHELL_COMMAND] } }
          : { name: toolNames.includes("exec_command") ? "exec_command" : toolNames[0], arguments: { cmd: SHELL_COMMAND } };
        return sse(res, completed(
          [{ type: "function_call", id: `fc_${calls}`, call_id: `call_${calls}`, name: call.name, arguments: JSON.stringify(call.arguments) }],
          usage(1200, 1000, 40, 16)
        ));
      }
      if (outputs === 1 && toolNames.includes("apply_patch")) {
        return sse(res, completed(
          [{ type: "custom_tool_call", id: `ctc_${calls}`, call_id: `call_${calls}`, name: "apply_patch", input: PATCH, status: "completed" }],
          usage(1400, 1200, 60, 20)
        ));
      }
      return sse(res, completed(
        [message("Done — `pong.txt` holds `pong` and `notes/pong.md` was added; both are uncommitted on the branch.")],
        usage(1500, 1300, 30, 0)
      ));
    }
    default:
      return sse(res, completed([message("pong")], usage(100, 0, 5, 0)));
  }
}

http
  .createServer((req, res) => {
    if (req.method === "GET" && req.url === "/__requests") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(requests, null, 2));
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      calls++;
      let parsed = null;
      try {
        parsed = body ? JSON.parse(body) : null;
      } catch {
        parsed = { unparseable: body.slice(0, 200) };
      }
      requests.push({ n: calls, at: new Date().toISOString(), method: req.method, url: req.url, authorization: req.headers.authorization ?? null, body: parsed });
      if (req.method !== "POST" || !req.url.endsWith("/responses") || parsed === null) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      answer(parsed, res);
    });
  })
  .listen(port, host, () => {
    console.log(`codex responses stub listening on http://${host}:${port}/v1 (scenario: ${scenario})`);
  });
