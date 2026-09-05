import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import type { ResolvedLane } from "@/lib/lanes/resolve";

// The adapters' output handlers write into the feed; nothing here exercises
// them, so the DB is stubbed rather than opened.
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/config", () => ({
  getConfig: () => ({ maxTurns: 50, maxBudgetUsd: 20 }),
}));

import {
  buildCodexTurnCommand,
  buildCodexTurnEnv,
  codexAdapter,
  codexRolloutPath,
  composeCodexSkillInvocation,
  mapCodexEffort,
  providerEnvKey,
  CODEX_AUTH_JSON_ENV,
  CODEX_BASE_URL_ENV,
  CODEX_PROMPT_ENV,
  CODEX_PROVIDER_ENV_KEY_ENV,
  CODEX_ROLLOUT_DIR,
  CODEX_SESSIONS_DIR,
} from "../codex";
import { CODEX_IMAGE } from "../codex/image";
import { describeHarnessAdapter } from "../descriptors";
import { getHarnessAdapter } from "../registry";
import { ALLOWED_TICKET_EFFORTS } from "@/lib/orchestrator/autonomy/budgets";
import { composeSeed } from "@/lib/sessions/seed";

/**
 * The Codex CLI adapter (issue #221): what one turn's exec environment and
 * command are built from, table-tested — the model pin, the effort mapping
 * (with the top-level collapse and "unmappable -> omitted"), the resume, base
 * URL delivery, credential delivery and its cleanup, and that no credential
 * ever reaches the command line.
 */

/** The metered Codex lane, as the resolver would hand it over. */
function lane(overrides: Partial<ResolvedLane> = {}): ResolvedLane {
  return {
    id: "openai-api",
    label: "OpenAI API",
    adapter: "codex",
    capabilities: describeHarnessAdapter("codex")!.capabilities,
    billing: "metered",
    auth: { CODEX_API_KEY: "sk-test-openai-secret" },
    baseUrl: null,
    tier: "heavy",
    model: "gpt-5.6-sol",
    prices: { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.4, cacheWritePerMTok: 5 },
    declaresPrices: true,
    caps: { dailyBudgetUsd: 20 },
    ...overrides,
  };
}

const AUTH_JSON = '{"auth_mode":"chatgpt","tokens":{"access_token":"eyJ-secret"}}';

/** The subscription lane: a ChatGPT credential file's contents, no prices. */
const subscriptionLane = () =>
  lane({
    id: "codex-subscription",
    label: "Codex (ChatGPT plan)",
    billing: "subscription",
    auth: { [CODEX_AUTH_JSON_ENV]: AUTH_JSON },
    prices: null,
    declaresPrices: false,
    caps: { dailyBudgetUsd: null },
  });

/** Does bash accept the script as syntax? The generated command runs under
 * `bash -c`, so a quoting slip is a pass that never starts. */
function bashAccepts(script: string): boolean {
  const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  return result.status === 0;
}

describe("the Codex adapter in the registry and the descriptor table (issue #221)", () => {
  it("is registered under the id the lane file names, with its descriptor's capabilities", () => {
    expect(getHarnessAdapter("codex")).toBe(codexAdapter);
    expect(codexAdapter.id).toBe("codex");
    expect(codexAdapter.capabilities).toEqual(describeHarnessAdapter("codex")!.capabilities);
  });

  it("declares what it cannot do: no quota telemetry, no cost, skills off until #224; and that it resumes", () => {
    expect(codexAdapter.capabilities).toEqual({
      userInvokedSkills: false,
      quotaTelemetry: false,
      reportsCost: false,
      sessionResume: true,
    });
  });

  it("declares its own image: a layer on the shared agent base (issue #216)", () => {
    expect(codexAdapter.image).toEqual(CODEX_IMAGE);
    expect(codexAdapter.image).toEqual({
      name: "interlude-agent-codex:latest",
      dockerfile: "Dockerfile.agent-codex",
    });
  });
});

describe("buildCodexTurnEnv", () => {
  it("carries the prompt and the git token, and passes the lane's auth through", () => {
    const env = buildCodexTurnEnv({
      prompt: "do the thing",
      gitAuthToken: "ghs_abc",
      ghToken: null,
      lane: lane(),
    });
    expect(env).toEqual([
      `${CODEX_PROMPT_ENV}=do the thing`,
      "GIT_AUTH_TOKEN=ghs_abc",
      "CODEX_API_KEY=sk-test-openai-secret",
    ]);
  });

  it("passes the ChatGPT credential file's contents through as a variable for the script to materialise", () => {
    const env = buildCodexTurnEnv({
      prompt: "p",
      gitAuthToken: "t",
      ghToken: null,
      lane: subscriptionLane(),
    });
    expect(env).toContain(`${CODEX_AUTH_JSON_ENV}=${AUTH_JSON}`);
    // Only the chosen lane's variables — two credentials never race.
    expect(env.some((e) => e.startsWith("CODEX_API_KEY"))).toBe(false);
  });

  it("delivers a lane's base URL with the credential variable the provider config will name", () => {
    const env = buildCodexTurnEnv({
      prompt: "p",
      gitAuthToken: "t",
      ghToken: null,
      lane: lane({
        id: "openai-compatible",
        auth: { MY_PROVIDER_KEY: "sk-other" },
        baseUrl: "https://example.test/v1",
      }),
    });
    expect(env).toContain(`${CODEX_BASE_URL_ENV}=https://example.test/v1`);
    expect(env).toContain(`${CODEX_PROVIDER_ENV_KEY_ENV}=MY_PROVIDER_KEY`);
  });

  it("names no base URL and no provider key when the lane declares no endpoint", () => {
    const env = buildCodexTurnEnv({ prompt: "p", gitAuthToken: "t", ghToken: null, lane: lane() });
    expect(env.some((e) => e.startsWith(CODEX_BASE_URL_ENV))).toBe(false);
    expect(env.some((e) => e.startsWith(CODEX_PROVIDER_ENV_KEY_ENV))).toBe(false);
  });

  it("never names the credential file variable as a provider key", () => {
    expect(providerEnvKey({ [CODEX_AUTH_JSON_ENV]: "{}" })).toBeNull();
    expect(providerEnvKey({ [CODEX_AUTH_JSON_ENV]: "{}", CODEX_API_KEY: "k" })).toBe("CODEX_API_KEY");
    const env = buildCodexTurnEnv({
      prompt: "p",
      gitAuthToken: "t",
      ghToken: null,
      lane: subscriptionLane(),
    });
    expect(env.some((e) => e.startsWith(CODEX_PROVIDER_ENV_KEY_ENV))).toBe(false);
  });

  // Issue #62: the isolation boundary carries over unchanged.
  it("exposes GH_TOKEN only when a generation-session token is supplied", () => {
    const withToken = buildCodexTurnEnv({ prompt: "p", gitAuthToken: "g", ghToken: "ghs_gh", lane: lane() });
    expect(withToken).toContain("GH_TOKEN=ghs_gh");
    const without = buildCodexTurnEnv({ prompt: "p", gitAuthToken: "g", ghToken: null, lane: lane() });
    expect(without.some((e) => e.startsWith("GH_TOKEN"))).toBe(false);
  });
});

describe("buildCodexTurnCommand", () => {
  const command = (input: Partial<Parameters<typeof buildCodexTurnCommand>[0]> = {}) =>
    buildCodexTurnCommand({ lane: lane(), ...input });

  it("runs codex exec headless with JSON output, bypassing approvals and the sandbox, in the workdir", () => {
    const cmd = command();
    expect(cmd).toContain("cd /workspace/repo || exit 1");
    expect(cmd).toContain("codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox");
    // A fresh Codex home would otherwise clone the plugin marketplace at every
    // turn start (measured; the flag stops it).
    expect(cmd).toContain("-c features.plugins=false");
    expect(bashAccepts(cmd)).toBe(true);
  });

  it("pipes the prompt to stdin from the environment, never onto the command line", () => {
    const cmd = command();
    expect(cmd).toContain(`printf '%s' "$${CODEX_PROMPT_ENV}" | codex exec`);
    expect(cmd.trim().endsWith(" -")).toBe(true);
  });

  it("pins the lane's model, single-quoted, and omits -m when the lane resolved none", () => {
    expect(command()).toContain("-m 'gpt-5.6-sol'");
    expect(command({ lane: lane({ model: null }) })).not.toContain("-m ");
  });

  it("maps the fleet's effort onto model_reasoning_effort, collapsing the top level onto Codex's top", () => {
    for (const level of ["low", "medium", "high", "xhigh"]) {
      expect(command({ effort: level })).toContain(`-c 'model_reasoning_effort="${level}"'`);
    }
    expect(command({ effort: "max" })).toContain(`-c 'model_reasoning_effort="xhigh"'`);
  });

  it("omits the effort setting for no level, and for a level it cannot map", () => {
    expect(command()).not.toContain("model_reasoning_effort");
    expect(command({ effort: null })).not.toContain("model_reasoning_effort");
    expect(command({ effort: "hihg" })).not.toContain("model_reasoning_effort");
  });

  it("resumes a prior session with codex exec resume <id>", () => {
    const cmd = command({ sessionId: "01a07292-348f-7fa1-9864-bc896b72144e" });
    expect(cmd).toContain("codex exec resume '01a07292-348f-7fa1-9864-bc896b72144e' --json");
    expect(bashAccepts(cmd)).toBe(true);
  });

  it("refuses a session id the CLI could not have minted rather than putting it on a command line", () => {
    expect(() => command({ sessionId: "abc'; rm -rf /" })).toThrow(/Refusing to resume/);
  });

  it("has no turn or spend ceiling to pass: Codex has neither flag", () => {
    const cmd = command({ maxTurns: 50, maxBudgetUsd: 20 });
    expect(cmd).not.toContain("--max-turns");
    expect(cmd).not.toContain("--max-budget-usd");
    // And never `--ephemeral`, which would stop the session persisting.
    expect(cmd).not.toContain("--ephemeral");
  });

  it("never puts a credential or an endpoint on the command line", () => {
    for (const l of [
      lane(),
      subscriptionLane(),
      lane({ auth: { MY_PROVIDER_KEY: "sk-other-secret" }, baseUrl: "https://example.test/v1" }),
    ]) {
      const cmd = buildCodexTurnCommand({ lane: l });
      expect(cmd).not.toContain("sk-test-openai-secret");
      expect(cmd).not.toContain("sk-other-secret");
      expect(cmd).not.toContain("eyJ-secret");
      expect(cmd).not.toContain("example.test");
    }
    // Both travel in the exec environment; the script only ever names the
    // variables. So the command is the same whatever the lane's endpoint.
    expect(buildCodexTurnCommand({ lane: lane({ baseUrl: "https://example.test/v1" }) })).toBe(
      buildCodexTurnCommand({ lane: lane() })
    );
  });

  describe("the per-exec Codex home", () => {
    const cmd = command();

    it("is created for the one exec, under the agent's home, and exported", () => {
      expect(cmd).toContain('CODEX_HOME="$(mktemp -d /home/node/.codex-exec.XXXXXX)" || exit 1');
      expect(cmd).toContain("export CODEX_HOME");
    });

    it("materialises the ChatGPT credential file from the environment, owner-only", () => {
      expect(cmd).toContain(
        `if [ -n "\${${CODEX_AUTH_JSON_ENV}:-}" ]; then (umask 077 && printf '%s' "$${CODEX_AUTH_JSON_ENV}" > "$CODEX_HOME/auth.json"); fi`
      );
    });

    it("is removed when the turn ends, on every exit path, so no credential file remains", () => {
      // The cleanup is part of the command itself: a trap on EXIT, so a turn
      // the CLI ended, a turn that failed and a turn bash was told to stop all
      // take the credential file with them.
      expect(cmd).toContain("trap interlude_codex_cleanup EXIT");
      expect(cmd).toContain('rm -rf -- "$CODEX_HOME"');
      const trapAt = cmd.indexOf("trap interlude_codex_cleanup EXIT");
      const authAt = cmd.indexOf('> "$CODEX_HOME/auth.json"');
      const runAt = cmd.indexOf("| codex exec");
      expect(trapAt).toBeGreaterThan(-1);
      // Armed before the credential is written, and before the CLI runs.
      expect(trapAt).toBeLessThan(authAt);
      expect(authAt).toBeLessThan(runAt);
    });

    it("links its sessions to the persistent directory, so a thread outlives the home", () => {
      expect(cmd).toContain(`ln -s ${CODEX_SESSIONS_DIR} "$CODEX_HOME/sessions"`);
      expect(cmd).toContain(`mkdir -p ${CODEX_ROLLOUT_DIR}`);
    });

    it("normalises each rollout the CLI wrote onto the deterministic name the artefact path derives", () => {
      expect(cmd).toContain(
        `find ${CODEX_SESSIONS_DIR} -type f -name 'rollout-*.jsonl' -not -path '${CODEX_ROLLOUT_DIR}/*'`
      );
      expect(cmd).toContain(
        `mv -f -- "$rollout" "${CODEX_ROLLOUT_DIR}/rollout-2000-01-01T00-00-00-\${name: -36}.jsonl"`
      );
    });

    it("writes a provider config carrying the lane's base URL only when one was delivered", () => {
      expect(cmd).toContain(`if [ -n "\${${CODEX_BASE_URL_ENV}:-}" ]; then`);
      expect(cmd).toContain('model_provider = "interlude"');
      expect(cmd).toContain("[model_providers.interlude]");
      expect(cmd).toContain('wire_api = "responses"');
      expect(cmd).toContain(`printf 'env_key = "%s"\\n' "$${CODEX_PROVIDER_ENV_KEY_ENV}" >> "$CODEX_HOME/config.toml"`);
    });
  });
});

describe("the widened contract on the Codex adapter (issue #214)", () => {
  it("maps every fleet effort level onto Codex's dial, the top two onto xhigh, and nothing else onto anything", () => {
    const expected: Record<string, string> = {
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "xhigh",
    };
    for (const level of ALLOWED_TICKET_EFFORTS) {
      expect(mapCodexEffort(level)).toBe(expected[level]);
      expect(codexAdapter.mapEffort(level)).toBe(expected[level]);
    }
    expect(mapCodexEffort("hihg")).toBeNull();
    expect(mapCodexEffort("")).toBeNull();
    expect(mapCodexEffort("minimal")).toBeNull();
  });

  it("invokes a skill as the $skill mention Codex documents, with the agenda after it", () => {
    expect(composeCodexSkillInvocation("grill-me", "the auth flow")).toBe("$grill-me the auth flow");
    expect(composeCodexSkillInvocation("wayfinder", null)).toBe("$wayfinder");
    expect(composeCodexSkillInvocation("to-spec", "   ")).toBe("$to-spec");
    // The seed composer puts it where the slash goes and keeps the framing.
    expect(
      composeSeed({ sessionSkill: "grill-me", agenda: "the auth flow" }, codexAdapter).split("\n\n")[0]
    ).toBe("$grill-me the auth flow");
  });

  it("names one rollout file as the session's artefact, on a deterministic canonical name, whatever the cwd", () => {
    const id = "01a07292-348f-7fa1-9864-bc896b72144e";
    const paths = codexAdapter.sessionArtifactPaths(id, "/workspace/repo");
    expect(paths).toEqual([codexRolloutPath(id)]);
    expect(paths).toEqual([
      "/home/node/.codex-sessions/interlude/rollout-2000-01-01T00-00-00-01a07292-348f-7fa1-9864-bc896b72144e.jsonl",
    ]);
    expect(codexAdapter.sessionArtifactPaths(id, "/elsewhere")).toEqual(paths);
    // The CLI refuses a rollout whose name is not canonical (measured): the
    // shape is rollout-<yyyy-mm-ddThh-mm-ss>-<thread id>.jsonl.
    expect(paths[0].split("/").pop()).toMatch(
      /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-f-]{36}\.jsonl$/
    );
    expect(paths[0].startsWith(`${CODEX_ROLLOUT_DIR}/`)).toBe(true);
  });
});
