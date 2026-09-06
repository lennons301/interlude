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
  describeToolPart,
  normaliseToolInput,
  readStepUsage,
  toolVerb,
} from "../opencode/stream-parser";
import { OPENCODE_TURN_EXIT_EVENT } from "../opencode/outcome";
import { quotaRefusalOf, refusedCredential } from "../turn-result";
import { toChatView } from "@/lib/chat/chat-view";
import { finalPassMessage, passProducedResult } from "@/lib/orchestrator/autonomy/pass-output";
import { parseReviewVerdict } from "@/lib/orchestrator/autonomy/verdict";
import { parseTriageExit } from "@/lib/orchestrator/autonomy/triage";
import { detectBlockedQuestion } from "@/lib/orchestrator/autonomy/blocked";

/**
 * The OpenCode stream parser over recordings of the real CLI (issue #222;
 * 1.18.29 in the built image, against OpenRouter): a turn on GLM 5.3 Flash
 * that ran two shell commands and finished with a message; the same session
 * resumed by id; an invalid key refused with a 401 by OpenRouter itself; and
 * two refusals recorded from the real CLI against a local stub replaying an
 * OpenRouter body — a 429 whose body was captured live from OpenRouter's free
 * tier, and a 402 with OpenRouter's documented wording (the account had
 * credits, so the provider would not produce one). Every fixture is the CLI's
 * stdout verbatim; the adapter's own terminal event is appended here exactly
 * as the turn script appends it, since the recordings are of the CLI and the
 * event is the wrapper's.
 */

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, name), "utf8");
const SUCCESS = fixture("opencode-stream-fixture.ndjson");
const RESUME = fixture("opencode-resume-fixture.ndjson");
const AUTH = fixture("opencode-auth-fixture.ndjson");
const RATE_LIMITED = fixture("opencode-rate-limit-fixture.ndjson");
const NO_CREDITS = fixture("opencode-credits-fixture.ndjson");

/** The session the success and resume recordings share. */
const SESSION_ID = "ses_f8c8647a3ffesld3PrZWwYuCz2";
const TASK_ID = "opencode-task-001";

/** A recording plus the turn script's terminal event, as the exec stream
 * carries them. */
const withExit = (ndjson: string, exitCode: number) =>
  `${ndjson.trimEnd()}\n{"type":"${OPENCODE_TURN_EXIT_EVENT}","exitCode":${exitCode}}\n`;

/** The success recording with its one text part saying something else — the
 * shape is the CLI's, the words are the test's. */
function saying(text: string): string {
  return SUCCESS.split("\n")
    .map((line) => {
      if (!line.trim()) return line;
      const event = JSON.parse(line) as { type: string; part?: { text?: string } };
      if (event.type === "text" && event.part) event.part.text = text;
      return JSON.stringify(event);
    })
    .join("\n");
}

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

function handlerFor(taskId = TASK_ID, recorder = fakeRecorder()) {
  return { handler: createOutputHandler(taskId, recorder), recorder };
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

beforeEach(() => {
  testDb = createTestDb().db;
  testDb.insert(schema.projects).values({ id: "test-project", name: "Test", createdAt: new Date() }).run();
  testDb
    .insert(schema.tasks)
    .values({
      id: TASK_ID,
      projectId: "test-project",
      title: "Test task",
      status: "running",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
});

describe("a recorded opencode run --format json turn", () => {
  it("parses to the session id, a clean outcome, the final message and the turn's usage", () => {
    const result = play(handlerFor().handler, withExit(SUCCESS, 0));

    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.outcome).toEqual({ kind: "completed" });
    expect(result.finalMessage).toBe("Done: pong.txt written");
    // Summed over the three steps (2950 + 203 + 39 input; output includes the
    // reasoning tokens: 17+173, 13+10, 7+0; cache reads 6848 + 9792 + 9984).
    expect(result.usage).toEqual({
      inputTokens: 3192,
      outputTokens: 220,
      cacheReadTokens: 26624,
      cacheWriteTokens: 0,
    });
    // The CLI's own estimate, summed — reported, not charged (the adapter
    // declares no reportsCost; the lane's prices charge the turn).
    expect(result.costUsd).toBeCloseTo(0.00037147 + 0.000167855 + 0.000154435, 10);
    // No quota telemetry on this wire.
    expect(result.rateLimit).toBeNull();
    expect(result.terminalResult).toEqual({ type: OPENCODE_TURN_EXIT_EVENT, exitCode: 0 });
    expect(passProducedResult(result)).toBe(true);
  });

  it("stores the text part as agent text", () => {
    play(handlerFor().handler, withExit(SUCCESS, 0));
    const texts = messagesOf(TASK_ID, "text");
    expect(texts).toHaveLength(1);
    expect(texts[0].role).toBe("agent");
    expect(contentOf(texts[0])).toEqual({ text: "Done: pong.txt written" });
  });

  it("stores each tool call as a tool event carrying its input, its result and its exit code", () => {
    play(handlerFor().handler, withExit(SUCCESS, 0));
    const tools = messagesOf(TASK_ID, "tool_use").map(contentOf);
    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual({
      tool: "Bash",
      input: { command: "printf 'pong' > pong.txt" },
      output: "(no output)",
      exit_code: 0,
    });
    expect(tools[1]).toEqual({
      tool: "Bash",
      input: { command: "cat pong.txt" },
      output: "pong",
      exit_code: 0,
    });
  });

  it("renders in the transcript as two shell rows and agent markdown — the same view a Claude turn gets", () => {
    play(handlerFor().handler, withExit(SUCCESS, 0));
    const view = toChatView(messagesOf(TASK_ID));
    const tools = view.filter((item) => item.kind === "tool-event");
    expect(tools.map((t) => (t.kind === "tool-event" ? t.verb : ""))).toEqual(["Bash", "Bash"]);
    expect(tools[0].kind === "tool-event" && tools[0].argument).toBe("printf 'pong' > pong.txt");
    expect(tools[1].kind === "tool-event" && tools[1].output).toBe("pong");
    expect(view.some((item) => item.kind === "agent-markdown")).toBe(true);
  });

  it("writes one turn-complete note with the tokens and the CLI's estimate, and reports done at the exit event", () => {
    const { handler } = handlerFor();
    let done = 0;
    handler.onDone(() => done++);
    for (const line of SUCCESS.split("\n")) if (line.trim()) handler.write(line + "\n");
    expect(done).toBe(0);
    handler.write(`{"type":"${OPENCODE_TURN_EXIT_EVENT}","exitCode":0}\n`);
    expect(done).toBe(1);
    const notes = messagesOf(TASK_ID, "system").map(contentOf);
    expect(notes).toEqual([{ text: "Turn complete (29816 input tokens (26624 cache reads), 220 output tokens; CLI estimate $0.0007)" }]);
  });

  it("forwards nothing it acted on to the recorder, and records a line that is not JSON on the feed", () => {
    const { handler, recorder } = handlerFor();
    handler.write("opencode: something the CLI said on stderr\n");
    play(handler, withExit(SUCCESS, 0));
    expect(recorder.events).toEqual([]);
    expect(recorder.lines).toEqual(["opencode: something the CLI said on stderr"]);
    expect(messagesOf(TASK_ID, "system").map(contentOf)[0]).toEqual({
      text: "opencode: something the CLI said on stderr",
    });
  });

  it("forwards an event type this build has not met to the recorder verbatim (issue #165)", () => {
    const { handler, recorder } = handlerFor();
    const novel = { type: "subagent_spawned", sessionID: SESSION_ID, part: { id: "x" } };
    handler.write(JSON.stringify(novel) + "\n");
    play(handler, withExit(SUCCESS, 0));
    expect(recorder.events).toEqual([novel]);
  });

  it("has no outcome when the exit event never arrives — the container died, or the wall clock stopped the tree", () => {
    const result = play(handlerFor().handler, SUCCESS);
    expect(result.outcome).toBeNull();
    expect(result.terminalResult).toBeNull();
    expect(passProducedResult(result)).toBe(false);
    // What was read before the death is still read.
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.finalMessage).toBe("Done: pong.txt written");
  });
});

describe("the same session resumed by id", () => {
  it("reports the session it continued, a clean outcome and its own usage", () => {
    const result = play(handlerFor().handler, withExit(RESUME, 0));
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.outcome).toEqual({ kind: "completed" });
    expect(result.finalMessage).toBe('pong.txt, containing the word "pong".');
    // One step: 3189 input, 11 output + 46 reasoning, 6848 cache reads — the
    // turn's own, not the session's running total.
    expect(result.usage).toEqual({
      inputTokens: 3189,
      outputTokens: 57,
      cacheReadTokens: 6848,
      cacheWriteTokens: 0,
    });
  });
});

describe("provider refusals", () => {
  it("reads OpenRouter's 401 for an invalid key as the credential refused (recorded live)", () => {
    const result = play(handlerFor().handler, withExit(AUTH, 1));
    expect(result.outcome).toEqual({
      kind: "refused",
      refusal: { kind: "auth", resumeAfter: null, limitType: null },
    });
    expect(refusedCredential(result.outcome)).toBe(true);
    expect(result.finalMessage).toBeNull();
    expect(result.usage).toBeNull();
    // The refusal's body rides with the exit for the recorder's pass-exit
    // record, verbatim.
    expect(result.terminalResult).toMatchObject({
      type: OPENCODE_TURN_EXIT_EVENT,
      exitCode: 1,
      lastError: { type: "error", error: { name: "APIError", data: { statusCode: 401 } } },
    });
    expect(messagesOf(TASK_ID, "system").map(contentOf)[0]).toEqual({ text: "Error: User not found." });
    // A review refused this way is not retried on the same lane (issue #220).
    expect(parseReviewVerdict(result)).toMatchObject({ kind: "unparseable", retryable: false });
  });

  it("reads a 429 as a quota wall with no stated reset (real CLI, OpenRouter's live 429 body)", () => {
    const result = play(handlerFor().handler, withExit(RATE_LIMITED, 1));
    expect(result.outcome).toEqual({
      kind: "refused",
      refusal: { kind: "quota", resumeAfter: null, limitType: null },
    });
    expect(quotaRefusalOf(result.outcome)).toEqual({ kind: "quota", resumeAfter: null, limitType: null });
    expect(finalPassMessage(result)).toEqual({
      ok: false,
      reason: "pass did not complete cleanly (refused: quota)",
    });
    expect(result.terminalResult).toMatchObject({
      lastError: { error: { data: { statusCode: 429, isRetryable: true } } },
    });
  });

  it("reads a 402 — insufficient credits — as the same quota wall", () => {
    const result = play(handlerFor().handler, withExit(NO_CREDITS, 1));
    expect(result.outcome).toEqual({
      kind: "refused",
      refusal: { kind: "quota", resumeAfter: null, limitType: null },
    });
    expect(messagesOf(TASK_ID, "system").map(contentOf)[0]).toEqual({
      text: "Error: Insufficient credits. Add more using https://openrouter.ai/settings/credits",
    });
  });
});

describe("the exit readers read the adapter's final message unchanged", () => {
  it("BLOCKED: marker", () => {
    const result = play(handlerFor().handler, withExit(saying("Two options.\n\nBLOCKED: Which database should the migration target?"), 0));
    expect(detectBlockedQuestion(result.finalMessage)).toBe("Which database should the migration target?");
  });

  it("review verdict", () => {
    const result = play(
      handlerFor().handler,
      withExit(saying("Looks solid — one nit inline.\n\nVERDICT: approve"), 0)
    );
    expect(parseReviewVerdict(result)).toMatchObject({ kind: "approve" });
  });

  it("triage exit, with its tier line", () => {
    const result = play(
      handlerFor().handler,
      withExit(saying("TRIAGE: recommend\nTIER: light\n\nA one-line guard; the body says where."), 0)
    );
    expect(parseTriageExit(result)).toMatchObject({ kind: "recommend", tier: "light" });
  });

  it("delivers no exit from a turn that did not complete, whatever its last words", () => {
    const result = play(handlerFor().handler, withExit(saying("VERDICT: approve"), 1));
    expect(parseReviewVerdict(result)).toMatchObject({ kind: "unparseable" });
  });
});

describe("tool parts", () => {
  it("renders an edit under the transcript's keys, so it gets the same line diff a Claude edit does", () => {
    const row = describeToolPart({
      type: "tool",
      tool: "edit",
      callID: "call_1",
      state: {
        status: "completed",
        input: { filePath: "/workspace/repo/src/a.ts", oldString: "const a = 1;", newString: "const a = 2;", replaceAll: false },
        output: "Edit applied",
        metadata: {},
      },
    });
    expect(row).toEqual({
      tool: "Edit",
      file_path: "/workspace/repo/src/a.ts",
      input: {
        file_path: "/workspace/repo/src/a.ts",
        old_string: "const a = 1;",
        new_string: "const a = 2;",
        replace_all: false,
      },
      output: "Edit applied",
    });
    const { handler } = handlerFor();
    handler.write(JSON.stringify({ type: "tool_use", sessionID: SESSION_ID, part: { type: "tool", tool: "edit", state: {
      status: "completed", input: { filePath: "/workspace/repo/src/a.ts", oldString: "const a = 1;", newString: "const a = 2;" }, output: "ok", metadata: {} } } }) + "\n");
    const [edit] = toChatView(messagesOf(TASK_ID)).filter((item) => item.kind === "tool-event");
    expect(edit.kind === "tool-event" && edit.verb).toBe("Edit");
    expect(edit.kind === "tool-event" && edit.argument).toBe("/workspace/repo/src/a.ts");
    expect(edit.kind === "tool-event" && edit.diff).toEqual({ removed: ["const a = 1;"], added: ["const a = 2;"] });
  });

  it("shows a failed call's error as its output", () => {
    expect(
      describeToolPart({
        tool: "bash",
        state: { status: "error", input: { command: "false" }, error: "exit code 1", metadata: { exit: 1 } },
      })
    ).toEqual({ tool: "Bash", input: { command: "false" }, output: "exit code 1", exit_code: 1 });
  });

  it("hands a malformed error event to the recorder as an unparseable line, not by type (which the recorder would drop)", () => {
    const { handler, recorder } = handlerFor();
    const malformed = { type: "error", sessionID: SESSION_ID, error: "boom" };
    handler.write(JSON.stringify(malformed) + "\n");
    expect(recorder.events).toEqual([]);
    expect(recorder.lines).toEqual([JSON.stringify(malformed)]);
    expect(messagesOf(TASK_ID)).toHaveLength(0);
    // Not a refusal either: nothing to read a status off.
    expect(play(handler, withExit("", 1)).outcome).toEqual({ kind: "failed", reason: "exit 1" });
  });

  it("is null for a part carrying no tool state, which the parser then records verbatim", () => {
    expect(describeToolPart({ type: "tool" })).toBeNull();
    const { handler, recorder } = handlerFor();
    const odd = { type: "tool_use", sessionID: SESSION_ID, part: { type: "tool" } };
    handler.write(JSON.stringify(odd) + "\n");
    expect(recorder.events).toEqual([odd]);
    expect(messagesOf(TASK_ID)).toHaveLength(0);
  });

  it("names tools as the transcript does", () => {
    expect(toolVerb("bash")).toBe("Bash");
    expect(toolVerb("read")).toBe("Read");
    expect(toolVerb("webfetch")).toBe("WebFetch");
    expect(toolVerb("todowrite")).toBe("TodoWrite");
    expect(toolVerb("skill")).toBe("Skill");
  });

  it("normalises only the argument names it knows, leaving the rest as the tool sent them", () => {
    expect(normaliseToolInput({ filePath: "/a", pattern: "*.ts", limit: 3 })).toEqual({
      file_path: "/a",
      pattern: "*.ts",
      limit: 3,
    });
    expect(normaliseToolInput(null)).toEqual({});
  });
});

describe("step usage", () => {
  it("reads a step's tokens with reasoning counted as output, and cache counts apart", () => {
    expect(
      readStepUsage({ tokens: { total: 100, input: 50, output: 20, reasoning: 5, cache: { read: 25, write: 0 } } })
    ).toEqual({ inputTokens: 50, outputTokens: 25, cacheReadTokens: 25, cacheWriteTokens: 0 });
  });

  it("is null for a step reporting no counts at all, so an empty report never prices as a free turn", () => {
    expect(readStepUsage({ reason: "stop" })).toBeNull();
    expect(readStepUsage({ tokens: {} })).toBeNull();
  });
});
