/**
 * The fake harness adapter (issue #214) — the test double every later ticket
 * in the multi-harness milestone builds on.
 *
 * Registered only under test (`registerHarnessAdapter`), never described in
 * the production descriptor table, so `lanes.yaml` can never name it. It emits
 * **scripted normalised outcomes**: a test says how each turn ends — in the
 * fleet's vocabulary, `completed | turn-limit | refused | failed` — and the
 * turn manager runs a whole turn, from lane resolution through the reducer's
 * decision, with no Claude Code and no Docker stream to parse. That is what
 * "the orchestrator is tested against a fake adapter" means: no suite outside
 * an adapter's own needs a vendor's stream format.
 *
 * It is a double for the *harness*, not for Docker: `execAgentTurn` and the
 * container manager are still stubbed by the suite that uses it, exactly as
 * they are in the quota-pause and repair-tier suites. The handler ignores what
 * is streamed at it and reports done at once, so the turn manager's race
 * settles on the handler's signal the way it does for a real turn.
 */

import { PassThrough } from "stream";
import { parseLaneConfig, type LaneCatalog } from "@/lib/lanes/lane-config";
import {
  HARNESS_ADAPTER_DESCRIPTORS,
  type HarnessAdapterDescriptor,
  type HarnessCapabilities,
} from "@/lib/harness/descriptors";
import type {
  HarnessAdapter,
  HarnessCommandInput,
  HarnessExecEnvInput,
  HarnessOutputHandler,
} from "@/lib/harness/adapter";
import type { TurnOutcome, TurnResult } from "@/lib/harness/turn-result";

export const FAKE_HARNESS_ID = "fake";

/**
 * A *second* fake adapter (issue #217): the same double under another id, so a
 * test can declare two lanes on two different harnesses and drive a lane move
 * across them. Never described in the production table either.
 */
export const FAKE_OTHER_HARNESS_ID = "fake-other";

/** A fake adapter declaring it cannot resume a session (issue #217): what a
 * run on such a lane does at a pause and a resume is what a test asks it. */
export const FAKE_NO_RESUME_HARNESS_ID = "fake-no-resume";

/** The fake's capabilities: everything a Claude lane has, except quota
 * telemetry — the one thing a second harness most plausibly lacks. */
export const FAKE_HARNESS_CAPABILITIES: HarnessCapabilities = {
  userInvokedSkills: true,
  quotaTelemetry: false,
  reportsCost: true,
  sessionResume: true,
};

/** The descriptor a test hands the lane parser so a lane may name a fake. */
export function fakeHarnessDescriptor(
  id: string = FAKE_HARNESS_ID,
  capabilities: HarnessCapabilities = FAKE_HARNESS_CAPABILITIES
): HarnessAdapterDescriptor {
  return { id, capabilities };
}

/** The production table plus the fake — what a test's lane file is parsed
 * against. */
export const DESCRIPTORS_WITH_FAKE: readonly HarnessAdapterDescriptor[] = [
  ...HARNESS_ADAPTER_DESCRIPTORS,
  fakeHarnessDescriptor(),
];

/** The production table plus every fake a multi-adapter test declares: the
 * second fake, and one that cannot resume a session. */
export const DESCRIPTORS_WITH_ALL_FAKES: readonly HarnessAdapterDescriptor[] = [
  ...DESCRIPTORS_WITH_FAKE,
  fakeHarnessDescriptor(FAKE_OTHER_HARNESS_ID),
  fakeHarnessDescriptor(FAKE_NO_RESUME_HARNESS_ID, {
    ...FAKE_HARNESS_CAPABILITIES,
    sessionResume: false,
  }),
];

/** The variable a fake lane reads its (fake) credential from. */
export const FAKE_LANE_AUTH_VAR = "FAKE_HARNESS_TOKEN";

/** A one-lane catalog on the fake adapter, as the lane file would declare it. */
export const FAKE_LANE_ID = "fake-lane";
export const FAKE_LANE_YAML = `
primary: ${FAKE_LANE_ID}
lanes:
  - id: ${FAKE_LANE_ID}
    label: Fake harness
    adapter: ${FAKE_HARNESS_ID}
    billing: subscription
    auth:
      ${FAKE_LANE_AUTH_VAR}: ${FAKE_LANE_AUTH_VAR}
    models:
      heavy: fake-heavy
      standard: fake-standard
      light: fake-light
`;

export function fakeLaneCatalog(): LaneCatalog {
  const parsed = parseLaneConfig(FAKE_LANE_YAML, DESCRIPTORS_WITH_FAKE);
  if (!parsed.ok) throw new Error(`fake lane file did not parse: ${parsed.reason}`);
  return parsed.catalog;
}

/** One lane of a multi-lane fake catalog: which adapter it runs, under what
 * label. Every such lane bills as a subscription and reads the one fake
 * credential, so what differs between them is only the harness. */
export interface FakeLaneSpec {
  id: string;
  adapter: string;
  label: string;
}

/** A lane file declaring the given lanes, in preference order as listed. */
export function fakeLaneYaml(lanes: readonly FakeLaneSpec[]): string {
  return [
    "primary:",
    ...lanes.map((lane) => `  - ${lane.id}`),
    "lanes:",
    ...lanes.flatMap((lane) => [
      `  - id: ${lane.id}`,
      `    label: ${lane.label}`,
      `    adapter: ${lane.adapter}`,
      "    billing: subscription",
      "    auth:",
      `      ${FAKE_LANE_AUTH_VAR}: ${FAKE_LANE_AUTH_VAR}`,
      "    models:",
      "      heavy: fake-heavy",
      "      standard: fake-standard",
      "      light: fake-light",
    ]),
    "",
  ].join("\n");
}

/** A catalog of the given lanes, parsed against every fake adapter's
 * descriptor (issue #217). */
export function fakeLaneCatalogOf(lanes: readonly FakeLaneSpec[]): LaneCatalog {
  const parsed = parseLaneConfig(fakeLaneYaml(lanes), DESCRIPTORS_WITH_ALL_FAKES);
  if (!parsed.ok) throw new Error(`fake lane file did not parse: ${parsed.reason}`);
  return parsed.catalog;
}

/** A scripted turn result: only the outcome is required; the rest defaults to
 * a small, clean, priced turn. */
export function scriptedTurn(
  outcome: TurnOutcome | null,
  overrides: Partial<Omit<TurnResult, "outcome">> = {}
): TurnResult {
  return {
    sessionId: "fake-session-1",
    costUsd: 0.05,
    finalMessage: "Done — implemented and pushed.",
    terminalResult: outcome === null ? null : { type: "result", fake: true },
    rateLimit: null,
    usage: null,
    ...overrides,
    outcome,
  };
}

/** What one exec asked of the adapter — recorded so a test can assert on the
 * inputs the orchestrator handed over without reaching into the turn manager. */
export interface FakeExec {
  taskId: string;
  laneId: string;
  env: HarnessExecEnvInput;
  command: HarnessCommandInput;
}

export interface FakeHarness {
  adapter: HarnessAdapter;
  /** Every turn asked for, in order. */
  execs: FakeExec[];
  /** Append results for the turns to come. */
  script(...results: TurnResult[]): void;
  /** Results scripted but not yet consumed. */
  pending(): number;
}

/** The one artefact a fake session has, where a fake adapter of `id` keeps it:
 * under the pass's working directory, so it is visibly not a vendor's path. */
export function fakeSessionArtifactPath(id: string, sessionId: string, cwd: string): string {
  return `${cwd}/.${id}/sessions/${sessionId}.json`;
}

/** A stream stub for a suite's `execAgentTurn` mock: never emits, never ends,
 * and inspects as finished — the handler's done signal wins the race. */
export function fakeExecStream() {
  return {
    stream: new PassThrough(),
    exec: { inspect: async () => ({ Running: false, ExitCode: 0 }) },
  };
}

export function createFakeHarness(
  script: TurnResult[] = [],
  options: { id?: string; capabilities?: HarnessCapabilities } = {}
): FakeHarness {
  const queue = [...script];
  const execs: FakeExec[] = [];
  const id = options.id ?? FAKE_HARNESS_ID;
  let pendingCommand: HarnessCommandInput | null = null;
  let pendingEnv: HarnessExecEnvInput | null = null;

  const adapter: HarnessAdapter = {
    id,
    image: { name: `interlude-agent-${id}:latest`, dockerfile: `Dockerfile.agent.${id}` },
    capabilities: options.capabilities ?? FAKE_HARNESS_CAPABILITIES,
    buildExecEnv(input) {
      pendingEnv = input;
      return [`FAKE_PROMPT=${input.prompt}`, `GIT_AUTH_TOKEN=${input.gitAuthToken}`];
    },
    buildCommand(input) {
      pendingCommand = input;
      return `fake-harness --model '${input.lane.model ?? ""}'`;
    },
    createOutputHandler(taskId, lane): HarnessOutputHandler {
      // The command and env builders were asked before the handler is written
      // to, so by the time a turn is recorded both inputs are in hand.
      const record = () => {
        if (pendingEnv && pendingCommand) {
          execs.push({ taskId, laneId: lane.id, env: pendingEnv, command: pendingCommand });
          pendingEnv = null;
          pendingCommand = null;
        }
      };
      return {
        write() {
          // Nothing to parse: the outcome is scripted.
        },
        onDone(callback) {
          // Report done on the next microtask, so the turn manager has both
          // promises of its race in hand — as a real stream's result event
          // would arrive after the exec is started.
          queueMicrotask(() => {
            record();
            callback();
          });
        },
        flush() {
          record();
          const next = queue.shift();
          if (!next) {
            throw new Error(
              `the fake harness was asked for a turn it has no script for (task ${taskId})`
            );
          }
          return next;
        },
      };
    },
    composeSkillInvocation(skill, agenda) {
      const trimmed = agenda?.trim();
      return trimmed ? `[fake: load skill ${skill}] ${trimmed}` : `[fake: load skill ${skill}]`;
    },
    sessionArtifactPaths(sessionId, cwd) {
      return [fakeSessionArtifactPath(id, sessionId, cwd)];
    },
    mapEffort(level) {
      // Deliberately a partial map: the fake knows "low" and "high" only, so a
      // test can see what an unmappable level does.
      return level === "low" || level === "high" ? `fake-${level}` : null;
    },
  };

  return {
    adapter,
    execs,
    script(...results) {
      queue.push(...results);
    },
    pending() {
      return queue.length;
    },
  };
}
