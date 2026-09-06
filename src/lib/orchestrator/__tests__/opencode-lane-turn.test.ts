import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { PassThrough } from "stream";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/create-test-db";
import * as schema from "@/db/schema";
import { newId } from "@/lib/ulid";
import { OPENCODE_IMAGE } from "@/lib/harness/opencode/image";
import { OPENCODE_TURN_EXIT_EVENT } from "@/lib/harness/opencode/outcome";

/**
 * A whole implement pass through the real `startTask` on the shipped OpenCode
 * lane (issue #222), over the real `lanes.yaml`: the lane resolves, the
 * container is created with the OpenCode image, the exec is the adapter's own
 * command and environment, the recorded stream of a real `opencode run
 * --format json` turn is parsed into the feed, and the run is charged at the
 * lane's prices. Only outbound I/O is stubbed (Docker, GitHub, Discord),
 * exactly as `fake-harness-turn.test.ts` stubs it; the exec stream is the
 * recording plus the terminal event the turn script appends.
 */

let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const docker = vi.hoisted(() => ({
  calls: [] as string[],
  images: [] as { name: string; dockerfile: string }[],
  execs: [] as { command: string; env: string[] }[],
  /** What the exec stream carries, set per test. */
  stream: "" as string,
}));

vi.mock("../../docker/container-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../docker/container-manager")>();
  return {
    ...actual,
    createWorkspaceContainer: async (options: { image: { name: string; dockerfile: string } }) => {
      docker.calls.push("createWorkspaceContainer");
      docker.images.push(options.image);
      return {
        container: {
          start: async () => undefined,
          // No Docker here: a pause's transcript copy fails and is logged,
          // which is the declared fallback (the continuation carries none).
          exec: async () => {
            throw new Error("no docker exec in this test");
          },
        },
        id: "ctr-opencode",
        name: "interlude-agent-opencode-test",
        previewSubdomain: "task-opencode",
      };
    },
    execSetup: async () => ({ skillsVersion: "9.9.9" }),
    execAgentTurn: async (options: { command: string; env: string[] }) => {
      docker.calls.push("execAgentTurn");
      docker.execs.push({ command: options.command, env: options.env });
      const stream = new PassThrough();
      // The CLI's stdout, then the script's terminal event, then the exec ends.
      setImmediate(() => {
        stream.write(docker.stream);
        stream.end();
      });
      return {
        stream,
        exec: { inspect: async () => ({ Running: false, ExitCode: 0 }) },
        turnId: "opencode-turn-1",
      };
    },
    execFallbackCommitAndPush: async () => {
      docker.calls.push("push");
      return { commitsAhead: 1 };
    },
    observeContainerAbsent: async () => false,
    startContainer: async () => docker.calls.push("startContainer"),
    stopContainer: async () => docker.calls.push("stopContainer"),
    removeContainer: async () => docker.calls.push("removeContainer"),
    stopAgentTurn: async () => {
      docker.calls.push("stopAgentTurn");
      return "stopped";
    },
  };
});

vi.mock("../../github/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../github/client")>();
  return { ...actual, getInstallationToken: async () => "ghs_fake_installation" };
});

const github = vi.hoisted(() => ({ comments: [] as string[] }));

vi.mock("../../github/issues", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../github/issues")>();
  return {
    ...actual,
    commentOnIssue: async (_ref: string, body: string) => {
      github.comments.push(body);
      return undefined;
    },
  };
});

vi.mock("../../github/pull-requests", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../github/pull-requests")>();
  return {
    ...actual,
    createDraftPr: async () => ({
      number: 41,
      url: "https://github.com/lennons301/lemons/pull/41",
      adopted: false,
    }),
    markPrReady: async () => undefined,
  };
});

vi.mock("../port-scanner", () => ({ scanPorts: async () => [3000] }));

vi.mock("../../discord/notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../discord/notifications")>();
  return {
    ...actual,
    notifyTaskQueued: async () => null,
    notifyTaskCompleted: async () => null,
    notifyTaskFailed: async () => null,
    notifyRunBlocked: async () => null,
  };
});

type TurnManager = typeof import("../turn-manager");

const LANE_ID = "opencode-openrouter-glm";
const KEY = "sk-or-v1-a-value-never-a-real-key";
const BRIEF = "Implement issue #34 — add the frobnicator.";
const SESSION_ID = "ses_f8c8647a3ffesld3PrZWwYuCz2";

const recording = fs.readFileSync(
  path.join(process.cwd(), "src/lib/harness/__tests__/opencode-stream-fixture.ndjson"),
  "utf8"
);
const withExit = (ndjson: string, exitCode: number) =>
  `${ndjson.trimEnd()}\n{"type":"${OPENCODE_TURN_EXIT_EVENT}","exitCode":${exitCode}}\n`;

let runId: string;
let taskId: string;

function seedImplementPass(): void {
  const projectId = newId();
  testDb
    .insert(schema.projects)
    .values({
      id: projectId,
      name: "lemons",
      gitUrl: "https://github.com/lennons301/lemons.git",
      createdAt: new Date(),
    })
    .run();
  runId = newId();
  testDb
    .insert(schema.runs)
    .values({
      id: runId,
      projectId,
      githubIssue: "lennons301/lemons#34",
      attempt: 1,
      mode: "autonomous",
      status: "claimed",
      budgetUsd: 20,
      model: "standard",
      claimedAt: new Date(),
    })
    .run();
  taskId = newId();
  testDb
    .insert(schema.tasks)
    .values({
      id: taskId,
      projectId,
      title: "Add the frobnicator",
      description: BRIEF,
      status: "queued",
      kind: "implement",
      runId,
      githubIssue: "lennons301/lemons#34",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  // The day's real-money confirmation (issue #174): the lane is metered, and
  // an unconfirmed day holds the pass rather than starting it.
  testDb
    .insert(schema.settings)
    .values({ id: "fleet", overrides: {}, meteredSpendConfirmedAt: new Date(), updatedAt: new Date() })
    .run();
}

const run = () => testDb.select().from(schema.runs).where(eq(schema.runs.id, runId)).get()!;
const task = () => testDb.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get()!;
const feed = () =>
  testDb
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.taskId, taskId))
    .all()
    .map((m) => ({ type: m.type, content: JSON.parse(m.content) as Record<string, unknown> }));

describe("an implement pass on the shipped OpenCode lane (issue #222)", () => {
  let turns: TurnManager;
  const env = { ...process.env };

  beforeEach(async () => {
    testDb = createTestDb().db;
    docker.calls.length = 0;
    docker.images.length = 0;
    docker.execs.length = 0;
    github.comments.length = 0;
    docker.stream = withExit(recording, 0);
    // The lane's credential — a value, never a real key — and the lane chosen
    // explicitly, as an operator would on the settings screen.
    process.env.OPENROUTER_API_KEY = KEY;
    process.env.AGENT_LANE = LANE_ID;
    delete process.env.AGENT_MODEL;
    delete process.env.TURN_WALL_CLOCK_MINUTES;
    vi.resetModules();
    const config = await import("@/lib/config");
    config.resetConfig();
    const catalog = await import("@/lib/lanes/catalog");
    catalog.resetLaneCatalog();
    turns = await import("../turn-manager");
    turns.getActiveTasks().clear();
    seedImplementPass();
  });

  afterEach(() => {
    process.env = { ...env };
    vi.restoreAllMocks();
  });

  it("runs the OpenCode image with the adapter's own exec, parses the recorded turn and charges the lane's prices", async () => {
    await turns.startTask(taskId);

    // The lane resolved to the OpenCode lane at the run's tier, and the rows
    // say which harness ran it (issue #223).
    expect(task().lane).toBe(LANE_ID);
    expect(task().laneBilling).toBe("metered");
    expect(task().tier).toBe("standard");
    expect(task().harness).toBe("opencode");
    expect(run().harness).toBe("opencode");
    expect(run().lane).toBe(LANE_ID);

    // The container runs the OpenCode image the lane's adapter declares.
    expect(docker.images).toEqual([OPENCODE_IMAGE]);
    expect(docker.images[0].name).toBe("interlude-agent-opencode:latest");

    // The exec is the adapter's command and environment: the model pinned in
    // provider/model form, the prompt piped from the environment, the
    // credential in the environment and nowhere on the command line.
    expect(docker.execs).toHaveLength(1);
    const { command, env: execEnv } = docker.execs[0];
    expect(command).toContain("opencode run --format json --pure --model 'openrouter/z-ai/glm-5.3-flash'");
    expect(command).toContain(`"type":"${OPENCODE_TURN_EXIT_EVENT}"`);
    expect(command).not.toContain(KEY);
    expect(command).not.toContain(BRIEF);
    expect(execEnv).toContain(`OPENROUTER_API_KEY=${KEY}`);
    expect(execEnv).toContain(`OPENCODE_PROMPT=${BRIEF}`);
    expect(execEnv).toContain("OPENCODE_DB=/home/node/.local/share/opencode/interlude.db");
    expect(execEnv.some((e) => e.startsWith("GH_TOKEN"))).toBe(false);
    expect(execEnv.some((e) => e.startsWith("ANTHROPIC"))).toBe(false);

    // The recorded stream landed on the feed in the transcript's shapes.
    const rows = feed();
    expect(rows.filter((r) => r.type === "tool_use").map((r) => r.content.tool)).toEqual(["Bash", "Bash"]);
    expect(rows.filter((r) => r.type === "text").map((r) => r.content.text)).toEqual(["Done: pong.txt written"]);
    expect(
      rows.some((r) => r.content.text === "Turn complete (29816 input tokens (26624 cache reads), 220 output tokens; CLI estimate $0.0007)")
    ).toBe(true);

    // A completed outcome is the ordinary implement path: pushed, PR opened
    // and marked ready, the container parked awaiting review.
    expect(docker.calls).toEqual(["createWorkspaceContainer", "execAgentTurn", "push", "stopContainer"]);
    expect(run().status).toBe("implementing");
    expect(run().pullRequestNumber).toBe(41);
    expect(task().sessionId).toBe(SESSION_ID);
    expect(task().containerStatus).toBe("idle");

    // Charged from the lane's declared prices (issue #175), not the CLI's
    // estimate: 3192 input at $0.075, 220 output at $0.25, 26624 cache reads
    // at $0.015 per Mtok.
    expect(task().totalCostUsd).toBeCloseTo(0.00069376, 8);
  });

  it("reads a recorded 429 on this lane as a wall, and fails over to the Claude Code lane on the same key — no attempt spent", async () => {
    const refused = fs.readFileSync(
      path.join(process.cwd(), "src/lib/harness/__tests__/opencode-rate-limit-fixture.ndjson"),
      "utf8"
    );
    docker.stream = withExit(refused, 1);

    await turns.startTask(taskId);

    // The refusal reached the reducer as `refused { quota }` and the wall
    // ordering ran on it: no tier named, so no degrade; the same OpenRouter key
    // makes `openrouter-glm` — the same models under Claude Code — available,
    // and a wall releases the pin (#176), so the run moves there rather than
    // parking. A cross-adapter move (#217): the continuation is queued on the
    // same attempt, carrying no session.
    expect(run().status).toBe("implementing");
    expect(run().attempt).toBe(1);
    expect(run().interruptionCount).toBe(0);
    expect(run().resumeCount).toBe(1);
    expect(task().status).toBe("failed");
    const continuation = testDb
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.runId, runId))
      .all()
      .find((t) => t.id !== taskId)!;
    expect(continuation.status).toBe("queued");
    expect(continuation.resumedFromTaskId).toBe(taskId);
    expect(continuation.sessionId).toBeNull();
    expect(github.comments.some((c) => c.includes("openrouter-glm"))).toBe(true);
    // The refused container is removed, not parked (#168).
    expect(docker.calls).toEqual(["createWorkspaceContainer", "execAgentTurn", "push", "removeContainer"]);
  });
});
