import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb } from "@/test/create-test-db";
import type { StreamRecorder } from "@/lib/orchestrator/stream-recorder";

let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

import {
  createOutputHandler,
  readThreadUsageBefore,
  turnUsageFromThread,
  THREAD_USAGE_KEY,
} from "../codex/stream-parser";
import { toChatView } from "@/lib/chat/chat-view";
import { finalPassMessage } from "@/lib/orchestrator/autonomy/pass-output";
import { parseReviewVerdict } from "@/lib/orchestrator/autonomy/verdict";
import { parseTriageExit } from "@/lib/orchestrator/autonomy/triage";
import { detectBlockedQuestion } from "@/lib/orchestrator/autonomy/blocked";

/**
 * The Codex stream parser over recordings of the real CLI (issue #221; 0.153.4,
 * recorded through `scripts/codex-responses-stub.mjs`): a turn that ran a
 * shell command, applied a patch and finished with a message; the same thread
 * resumed; an API-key 429; and a ChatGPT-plan usage wall.
 */

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, name), "utf8");
const SUCCESS = fixture("codex-stream-fixture.ndjson");
const RESUME = fixture("codex-resume-fixture.ndjson");
const RATE_LIMITED = fixture("codex-rate-limit-fixture.ndjson");
const USAGE_WALL = fixture("codex-usage-limit-fixture.ndjson");

/** The thread the success and resume recordings share. */
const THREAD_ID = "01a07292-348f-7fa1-9864-bc896b72144e";
const TASK_ID = "codex-task-001";
/** 18:16 local on the day the fixtures were recorded. */
const NOW = new Date(2026, 8, 5, 18, 16, 0);

function fakeRecorder(): StreamRecorder & { events: Record<string, unknown>[]; lines: string[] } {
  const events: Record<string, unknown>[] = [];
  const lines: string[] = [];
  return {
    events,
    lines,
    streamEvent: (_taskId, event) => void events.push(event),
    unparseableLine: (_taskId, line) => void lines.push(line),
    passExit: () => {},
  };
}

function handlerFor(taskId = TASK_ID, recorder = fakeRecorder(), now = () => NOW) {
  return { handler: createOutputHandler(taskId, recorder, now), recorder };
}

/** Feed a recording line by line, as the exec stream would, and flush. */
function play(handler: ReturnType<typeof createOutputHandler>, ndjson: string) {
  for (const line of ndjson.split("\n")) {
    if (line.trim()) handler.write(line + "\n");
  }
  return handler.flush();
}

const messagesOf = (taskId: string, type?: string) =>
  testDb
    .select()
    .from(schema.messages)
    .where(
      type
        ? and(eq(schema.messages.taskId, taskId), eq(schema.messages.type, type as "text"))
        : eq(schema.messages.taskId, taskId)
    )
    .all();

const contentOf = (row: { content: string }) => JSON.parse(row.content) as Record<string, unknown>;

function insertTask(id: string, sessionId: string | null = null) {
  testDb
    .insert(schema.tasks)
    .values({
      id,
      projectId: "test-project",
      title: "Test task",
      status: "running",
      sessionId,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
}

beforeEach(() => {
  testDb = createTestDb().db;
  testDb.insert(schema.projects).values({ id: "test-project", name: "Test", createdAt: new Date() }).run();
  insertTask(TASK_ID);
});

describe("a recorded codex exec --json run", () => {
  it("parses to the session id, a clean outcome, the final message and the turn's usage", () => {
    const { handler } = handlerFor();
    const result = play(handler, SUCCESS);

    expect(result.sessionId).toBe(THREAD_ID);
    expect(result.outcome).toEqual({ kind: "completed" });
    expect(result.finalMessage).toBe(
      "Done — `pong.txt` holds `pong` and `notes/pong.md` was added; both are uncommitted on the branch."
    );
    // The wire's `input_tokens` includes the cached tokens; the fleet's shape
    // counts them apart. Output includes reasoning, as the wire's does.
    expect(result.usage).toEqual({
      inputTokens: 600,
      outputTokens: 130,
      cacheReadTokens: 3500,
      cacheWriteTokens: 0,
    });
    // No dollar figure and no quota telemetry on this wire.
    expect(result.costUsd).toBe(0);
    expect(result.rateLimit).toBeNull();
    expect(result.terminalResult).toMatchObject({ type: "turn.completed" });
  });

  it("stores the agent message as agent text", () => {
    play(handlerFor().handler, SUCCESS);
    const texts = messagesOf(TASK_ID, "text");
    expect(texts).toHaveLength(1);
    expect(texts[0].role).toBe("agent");
    expect(contentOf(texts[0]).text).toContain("`pong.txt` holds `pong`");
  });

  it("stores the shell command and the patch as tool events, with their results", () => {
    play(handlerFor().handler, SUCCESS);
    const tools = messagesOf(TASK_ID, "tool_use").map(contentOf);
    expect(tools).toHaveLength(2);

    const [shell, patch] = tools;
    expect(shell.tool).toBe("Shell");
    expect((shell.input as Record<string, unknown>).command).toBe(
      "/bin/bash -lc \"printf 'pong\\\\n' > pong.txt && cat pong.txt\""
    );
    expect(shell.output).toBe("pong\n");
    expect(shell.exit_code).toBe(0);

    expect(patch.tool).toBe("Patch");
    expect(patch.file_path).toBe("/tmp/codex-probe/rec-success/notes/pong.md");
    expect((patch.input as { changes: unknown[] }).changes).toEqual([
      { path: "/tmp/codex-probe/rec-success/notes/pong.md", kind: "add" },
    ]);
    expect(patch.output).toBe("add /tmp/codex-probe/rec-success/notes/pong.md");
  });

  it("inserts a tool row when the item starts and completes that same row when it ends", () => {
    const { handler } = handlerFor();
    const lines = SUCCESS.split("\n").filter((l) => l.trim());
    // thread.started, turn.started, item.started (the command)
    for (const line of lines.slice(0, 3)) handler.write(line + "\n");
    const running = messagesOf(TASK_ID, "tool_use");
    expect(running).toHaveLength(1);
    expect(contentOf(running[0]).output).toBeUndefined();

    for (const line of lines.slice(3)) handler.write(line + "\n");
    handler.flush();
    const finished = messagesOf(TASK_ID, "tool_use");
    expect(finished.map((m) => m.id)).toContain(running[0].id);
    expect(contentOf(finished.find((m) => m.id === running[0].id)!).output).toBe("pong\n");
  });

  it("renders in the transcript as a shell row, a patch row and agent markdown — the same view a Claude turn gets", () => {
    play(handlerFor().handler, SUCCESS);
    const view = toChatView(messagesOf(TASK_ID));
    const tools = view.filter((item) => item.kind === "tool-event");
    expect(tools.map((t) => (t.kind === "tool-event" ? t.verb : ""))).toEqual(["Shell", "Patch"]);
    expect(tools[0].kind === "tool-event" && tools[0].argument).toContain("printf 'pong");
    expect(tools[0].kind === "tool-event" && tools[0].output).toBe("pong\n");
    expect(tools[1].kind === "tool-event" && tools[1].argument).toBe(
      "/tmp/codex-probe/rec-success/notes/pong.md"
    );
    expect(view.some((item) => item.kind === "agent-markdown")).toBe(true);
  });

  it("writes the thread's running total on the turn-complete note, for the next turn's difference", () => {
    play(handlerFor().handler, SUCCESS);
    const notes = messagesOf(TASK_ID, "system").map(contentOf);
    const complete = notes.find((n) => typeof n.text === "string" && n.text.startsWith("Turn complete"));
    expect(complete?.text).toBe("Turn complete (4100 input tokens, 130 output tokens)");
    expect(complete?.[THREAD_USAGE_KEY]).toEqual({
      input_tokens: 4100,
      cached_input_tokens: 3500,
      cache_write_input_tokens: 0,
      output_tokens: 130,
      reasoning_output_tokens: 36,
    });
  });

  it("forwards nothing it understood to the recorder", () => {
    const { handler, recorder } = handlerFor();
    play(handler, SUCCESS);
    expect(recorder.events).toEqual([]);
    expect(recorder.lines).toEqual([]);
  });
});

describe("usage is the thread's running total on the wire, and the turn's in the result", () => {
  it("charges a resumed turn only what it spent, reading the prior total off the same task's feed", () => {
    play(handlerFor().handler, SUCCESS);
    // The turn manager records the session id on the row once the turn ends.
    testDb.update(schema.tasks).set({ sessionId: THREAD_ID }).where(eq(schema.tasks.id, TASK_ID)).run();
    expect(readThreadUsageBefore(THREAD_ID)?.input_tokens).toBe(4100);

    const result = play(handlerFor().handler, RESUME);
    expect(result.sessionId).toBe(THREAD_ID);
    // The wire said 4200 / 135 — the whole thread. The turn spent 100 / 5.
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(result.finalMessage).toBe("pong");
  });

  it("reads the prior total off a predecessor task sharing the session id — a resumed pass is a new row", () => {
    play(handlerFor().handler, SUCCESS);
    testDb.update(schema.tasks).set({ sessionId: THREAD_ID }).where(eq(schema.tasks.id, TASK_ID)).run();
    insertTask("codex-task-002", THREAD_ID);

    const result = play(handlerFor("codex-task-002").handler, RESUME);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });
    // And its own note carries the new total, for the turn after — found as
    // the largest, though both notes here carry the same fixed clock.
    expect(readThreadUsageBefore(THREAD_ID)?.input_tokens).toBe(4200);
  });

  it("reads the largest total, not the newest note, since a thread's total only grows", () => {
    // A predecessor row whose clock ran ahead of ours: its older, smaller total
    // is dated later. The largest is still the latest the thread reached.
    insertTask("codex-task-002", THREAD_ID);
    testDb.update(schema.tasks).set({ sessionId: THREAD_ID }).where(eq(schema.tasks.id, TASK_ID)).run();
    const note = (taskId: string, input: number, at: Date) =>
      testDb.insert(schema.messages).values({
        id: `${taskId}-${input}`,
        taskId,
        role: "system",
        type: "system",
        content: JSON.stringify({
          text: "Turn complete",
          [THREAD_USAGE_KEY]: { input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
        }),
        createdAt: at,
      }).run();
    note("codex-task-002", 4100, new Date(2026, 8, 5, 12, 0, 5));
    note(TASK_ID, 4200, new Date(2026, 8, 5, 12, 0, 0));
    expect(readThreadUsageBefore(THREAD_ID)?.input_tokens).toBe(4200);
  });

  it("charges the whole total for a thread the feed has never seen — which for a fresh thread is the turn", () => {
    const result = play(handlerFor().handler, RESUME);
    expect(result.usage).toEqual({ inputTokens: 700, outputTokens: 135, cacheReadTokens: 3500, cacheWriteTokens: 0 });
  });

  it("floors each difference at zero and keeps cached tokens apart from input", () => {
    const before = { input_tokens: 500, cached_input_tokens: 400, cache_write_input_tokens: 10, output_tokens: 50, reasoning_output_tokens: 5 };
    expect(
      turnUsageFromThread(
        { input_tokens: 800, cached_input_tokens: 600, cache_write_input_tokens: 10, output_tokens: 70, reasoning_output_tokens: 9 },
        before
      )
    ).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 200, cacheWriteTokens: 0 });
    // A total that went down is a thread the CLI restarted counting for.
    expect(
      turnUsageFromThread(
        { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0 },
        before
      )
    ).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });
});

describe("a recorded refusal", () => {
  it("parses an API-key 429 to refused { quota } with no clock, no usage and no final message", () => {
    const { handler } = handlerFor();
    const result = play(handler, RATE_LIMITED);
    expect(result.outcome).toEqual({
      kind: "refused",
      refusal: { kind: "quota", resumeAfter: null, limitType: null },
    });
    expect(result.sessionId).toBe("01a07292-4b12-7fb2-b888-555539512b9a");
    expect(result.usage).toBeNull();
    expect(result.finalMessage).toBeNull();
    expect(result.terminalResult).toMatchObject({ type: "turn.failed" });
    // The exit readers see no clean finish to read.
    expect(finalPassMessage(result)).toMatchObject({ ok: false });
  });

  it("parses a ChatGPT-plan usage wall to refused { quota } with the clock time the CLI named", () => {
    const result = play(handlerFor().handler, USAGE_WALL);
    expect(result.outcome).toEqual({
      kind: "refused",
      refusal: { kind: "quota", resumeAfter: new Date(2026, 8, 5, 21, 16, 0), limitType: null },
    });
  });

  it("notes the CLI's sentence on the feed once, though the stream says it twice", () => {
    play(handlerFor().handler, RATE_LIMITED);
    const errors = messagesOf(TASK_ID, "system")
      .map(contentOf)
      .filter((n) => typeof n.text === "string" && n.text.startsWith("Error:"));
    expect(errors).toHaveLength(1);
    expect(errors[0].text).toBe("Error: exceeded retry limit, last status: 429 Too Many Requests");
  });
});

describe("what reaches the recorder (issue #165)", () => {
  it("forwards an event type it has not met, verbatim", () => {
    const { handler, recorder } = handlerFor();
    handler.write('{"type":"thread.renamed","thread_id":"t","name":"x"}\n');
    handler.flush();
    expect(recorder.events).toEqual([{ type: "thread.renamed", thread_id: "t", name: "x" }]);
  });

  it("forwards an item kind it has not met, and still shows it as a tool row", () => {
    const { handler, recorder } = handlerFor();
    const event = { type: "item.completed", item: { id: "item_9", type: "collab_tool_call", tool: "spawn_agent", status: "completed" } };
    handler.write(JSON.stringify(event) + "\n");
    handler.flush();
    expect(recorder.events).toEqual([event]);
    const tools = messagesOf(TASK_ID, "tool_use").map(contentOf);
    expect(tools).toEqual([{ tool: "collab_tool_call", input: { tool: "spawn_agent" }, output: "" }]);
  });

  it("hands a line that is not JSON to the recorder and shows it on the feed", () => {
    const { handler, recorder } = handlerFor();
    handler.write("Error: thread/resume failed: no rollout found for thread id 1111\n");
    const result = handler.flush();
    expect(recorder.lines).toEqual(["Error: thread/resume failed: no rollout found for thread id 1111"]);
    expect(messagesOf(TASK_ID, "system").map(contentOf)).toEqual([
      { text: "Error: thread/resume failed: no rollout found for thread id 1111" },
    ]);
    // No turn-ending event arrived: the interruption bound owns this.
    expect(result.outcome).toBeNull();
  });

  it("reads a partial last line at flush", () => {
    const { handler } = handlerFor();
    handler.write('{"type":"thread.started","thread_id":"abc"}\n{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}');
    const result = handler.flush();
    expect(result.sessionId).toBe("abc");
    expect(result.outcome).toEqual({ kind: "completed" });
  });
});

/**
 * The exit readers take the adapter's final message unchanged: what the agent
 * wrote as its last message is what the blocked-marker detector, the review
 * verdict parser and the triage exit parser read — on this harness as on
 * Claude Code.
 */
describe("the BLOCKED marker, the review verdict and the triage exit read the final message unchanged", () => {
  /** A turn in the recorded shape whose one agent message is `text`. */
  const turnSaying = (text: string) =>
    [
      { type: "thread.started", thread_id: THREAD_ID },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n";

  it("hands the review verdict parser the verdict the agent wrote", () => {
    const result = play(handlerFor().handler, turnSaying("VERDICT: approve\n\nSmall, tested, matches the ticket."));
    expect(finalPassMessage(result)).toEqual({
      ok: true,
      message: "VERDICT: approve\n\nSmall, tested, matches the ticket.",
    });
    expect(parseReviewVerdict(result)).toMatchObject({ kind: "approve" });
  });

  it("hands the triage exit parser the exit the agent wrote, tier line included", () => {
    const result = play(handlerFor().handler, turnSaying("TRIAGE: recommend\nTIER: light\n\nOne file, clear criteria."));
    expect(parseTriageExit(result)).toMatchObject({ kind: "recommend", tier: "light" });
  });

  it("hands the blocked-marker detector the question the agent asked", () => {
    const result = play(handlerFor().handler, turnSaying("I need a decision.\n\nBLOCKED: Which auth flow should the tests target?"));
    expect(detectBlockedQuestion(result.finalMessage)).toBe("Which auth flow should the tests target?");
  });

  it("reads the last agent message when a turn writes several", () => {
    const stream =
      [
        { type: "thread.started", thread_id: THREAD_ID },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "Looking at the diff now." } },
        { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "VERDICT: request-changes\n\nThe migration lacks a snapshot." } },
        { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n";
    const result = play(handlerFor().handler, stream);
    expect(parseReviewVerdict(result)).toMatchObject({ kind: "request-changes" });
    expect(messagesOf(TASK_ID, "text")).toHaveLength(2);
  });
});
