import { db } from "@/db";
import { messages } from "@/db/schema";
import { newId } from "../../ulid";
import {
  getStreamRecorder,
  type StreamRecorder,
} from "../../orchestrator/stream-recorder";
import type { TurnTokenUsage } from "../../lanes/lane-cost";
import type { HarnessOutputHandler } from "../adapter";
import type { TurnResult } from "../turn-result";
import {
  classifyOpenCodeExit,
  OPENCODE_ERROR_EVENT,
  OPENCODE_TURN_EXIT_EVENT,
  readOpenCodeError,
  type OpenCodeError,
} from "./outcome";

/**
 * Parse `opencode run --format json` output and insert messages into the feed
 * (issue #222) — the OpenCode adapter's own parser, as
 * `claude-code/stream-parser.ts` is Claude Code's. The orchestrator sees only
 * the `TurnResult` it hands back, whose `outcome` is the fleet's vocabulary
 * (`./outcome.ts`) and never this stream's.
 *
 * The stream is one JSON object per line, every one carrying `type`,
 * `timestamp` and `sessionID` (recorded against 1.18.29 — the fixtures beside
 * the tests are the evidence; the CLI documents no schema for it):
 *
 * - `step_start` `{ part }`: one LLM call begins. Nothing to read.
 * - `tool_use` `{ part }`: a tool call, emitted once, when it has finished —
 *   `part.tool` is the tool's name, `part.state` its `status` (`completed` or
 *   `error`), `input`, `output` and `metadata` (`exit` for a shell command).
 * - `text` `{ part }`: a completed text part, whole — `part.text`.
 * - `step_finish` `{ part }`: the call's end, with `part.reason` (`tool-calls`
 *   for a step that continues, `stop` for the last), `part.tokens` (`input`,
 *   `output`, `reasoning`, `cache.read`, `cache.write`) and `part.cost`.
 * - `reasoning` `{ part }`: a thinking block, only under `--thinking`. Dropped,
 *   as Claude Code's thinking blocks are.
 * - `error` `{ error }`: a provider or CLI error — the refusal shape
 *   `./outcome.ts` reads.
 * - `interlude.turn_exit` `{ exitCode }`: the adapter's own terminal event,
 *   written by the turn script after the CLI exits (see `./outcome.ts` for why
 *   there has to be one).
 *
 * Parts map onto the stored message shapes the transcript renders
 * (`toChatView`): a `text` part is an agent text row; a `tool_use` part is a
 * tool row whose `tool` is the transcript's verb for the tool (OpenCode's
 * lower-case `bash` renders as the `Bash` a Claude turn shows) and whose
 * `input` carries the tool's arguments under the keys the transcript already
 * reads — OpenCode's `filePath`/`oldString`/`newString` become `file_path`/
 * `old_string`/`new_string`, so an OpenCode edit shows the same line diff a
 * Claude edit does. One transcript, whoever is on the other end.
 *
 * **Usage is per step on the wire and summed here.** Each `step_finish`
 * carries that call's tokens (measured: a three-step turn reported 2950, 203
 * and 39 input tokens, each with its own cache read), so the turn's usage is
 * the sum over its steps — the fleet's shape counts thinking in output, so
 * `reasoning` is added to `output`. `part.cost` is summed the same way into
 * `costUsd`: it is the CLI's estimate from the models.dev catalogue, not the
 * provider's bill, which is why the adapter declares no `reportsCost` and a
 * metered OpenCode lane must declare prices — on the shipped lane the lane's
 * prices charge the turn and the estimate rides beside them as the harness's
 * reported figure (`reportedUsd` on the feed). A *subscription* OpenCode lane
 * (legal under #219, none shipped) declares no prices, so `chargeForTurn`
 * would book this estimate against the daily autonomous cap as the harness's
 * figure — a catalogue price for quota already bought, the over-stating side.
 *
 * **What reaches the recorder (issue #165).** The recorder's allowlist
 * (`KNOWN_STREAM_EVENT_TYPES`) is the Claude Code parser's vocabulary and it
 * caps each event type per turn, so this parser forwards only what it did not
 * act on: an event of a type this build has not met. One collision, known and
 * bounded: `error` is a name both harnesses use, so a malformed `error` event
 * forwarded by type would be dropped there as one of Claude's known types —
 * it is handed over as an unparseable line instead, which the recorder always
 * keeps, because to this parser that is what it is. A well-formed refusal is
 * kept another way — the terminal result handed back carries the last `error`
 * event verbatim under `lastError`, and `runTurn` records the terminal result
 * whole. A line that is not JSON is handed over and noted on the feed, because
 * it is the CLI's stderr (merged into the stream) saying something went wrong.
 */

/** The wire's tool names that do not capitalise to the transcript's verb by
 * their first letter alone. Everything else (`bash`, `read`, `edit`, `write`,
 * `glob`, `grep`, `list`, `task`, `skill`, `patch`) does. */
const TOOL_VERBS: Readonly<Record<string, string>> = {
  webfetch: "WebFetch",
  websearch: "WebSearch",
  todowrite: "TodoWrite",
  todoread: "TodoRead",
  multiedit: "MultiEdit",
};

/** OpenCode's camel-case argument names, under the snake-case keys the
 * transcript's argument and diff rules read. */
const INPUT_KEYS: Readonly<Record<string, string>> = {
  filePath: "file_path",
  oldString: "old_string",
  newString: "new_string",
  replaceAll: "replace_all",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The cached share of a turn's input, as the clause the turn-complete note
 * adds after the input total: `, of which N cache reads` — and the writes
 * too when the provider reports any (the wire carries both counts; the
 * shipped lane's provider reports no writes). Empty when neither happened,
 * so the note says nothing it cannot back.
 */
export function cacheDetail(usage: TurnTokenUsage): string {
  const parts: string[] = [];
  if (usage.cacheReadTokens > 0) parts.push(`${usage.cacheReadTokens} cache reads`);
  if (usage.cacheWriteTokens > 0) parts.push(`${usage.cacheWriteTokens} cache writes`);
  return parts.length === 0 ? "" : `, of which ${parts.join(" and ")}`;
}

/** The transcript's verb for one of OpenCode's tool names. */
export function toolVerb(tool: string): string {
  return TOOL_VERBS[tool] ?? tool.charAt(0).toUpperCase() + tool.slice(1);
}

/** A tool's arguments under the keys the transcript reads. */
export function normaliseToolInput(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) return {};
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [INPUT_KEYS[key] ?? key, value])
  );
}

/** What a tool row shows for one finished tool call. */
export interface ToolRow {
  tool: string;
  file_path?: string;
  input: Record<string, unknown>;
  output: string;
  exit_code?: number | null;
}

/**
 * A `tool_use` part as a feed row, or null when the part carries no tool state
 * this build can render (it is then recorded verbatim by the caller).
 */
export function describeToolPart(part: Record<string, unknown>): ToolRow | null {
  const tool = readString(part.tool);
  const state = part.state;
  if (tool === null || !isRecord(state)) return null;
  const input = normaliseToolInput(state.input);
  const status = readString(state.status);
  // A failed call's one useful line is its error; a finished one's is its
  // output. Both are what the transcript's expanded row shows.
  const output =
    status === "error"
      ? (readString(state.error) ?? "error")
      : (readString(state.output) ?? "");
  const row: ToolRow = { tool: toolVerb(tool), input, output };
  const filePath = readString(input.file_path);
  if (filePath !== null) row.file_path = filePath;
  const metadata = isRecord(state.metadata) ? state.metadata : {};
  if (typeof metadata.exit === "number") row.exit_code = metadata.exit;
  return row;
}

/** One step's tokens off a `step_finish` part, or null when it reports none. */
export function readStepUsage(part: Record<string, unknown>): TurnTokenUsage | null {
  const tokens = part.tokens;
  if (!isRecord(tokens)) return null;
  const input = readCount(tokens.input);
  const output = readCount(tokens.output);
  if (input === null && output === null) return null;
  const cache = isRecord(tokens.cache) ? tokens.cache : {};
  return {
    inputTokens: input ?? 0,
    // Thinking is output on the provider's bill, and the fleet's shape counts
    // it there (issue #175).
    outputTokens: (output ?? 0) + (readCount(tokens.reasoning) ?? 0),
    cacheReadTokens: readCount(cache.read) ?? 0,
    cacheWriteTokens: readCount(cache.write) ?? 0,
  };
}

function addUsage(a: TurnTokenUsage | null, b: TurnTokenUsage): TurnTokenUsage {
  if (a === null) return b;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/** The event types this parser acts on; anything else is forwarded to the
 * recorder verbatim (issue #165). */
const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
  "step_start",
  "step_finish",
  "tool_use",
  "text",
  "reasoning",
  OPENCODE_ERROR_EVENT,
  OPENCODE_TURN_EXIT_EVENT,
]);

export function createOutputHandler(
  taskId: string,
  /** Injectable so the recorder can be observed in tests without a filesystem;
   * production always takes the process-wide one. */
  recorder: StreamRecorder = getStreamRecorder(),
  /** The clock feed rows are stamped with. */
  now: () => Date = () => new Date()
): HarnessOutputHandler & { write(chunk: Buffer | string): void } {
  let buffer = "";
  let sessionId: string | null = null;
  let finalMessage: string | null = null;
  let terminal: Record<string, unknown> | null = null;
  let usage: TurnTokenUsage | null = null;
  let costUsd = 0;
  let lastErrorEvent: Record<string, unknown> | null = null;
  let lastError: OpenCodeError | null = null;
  let onDone: (() => void) | null = null;

  const insert = (
    role: "agent" | "system",
    type: "text" | "tool_use" | "system",
    content: object
  ): void => {
    db.insert(messages)
      .values({
        id: newId(),
        taskId,
        role,
        type,
        content: JSON.stringify(content),
        createdAt: now(),
      })
      .run();
  };

  const systemNote = (text: string, extra: Record<string, unknown> = {}) =>
    insert("system", "system", { text, ...extra });

  const handleEvent = (event: Record<string, unknown>): void => {
    const type = readString(event.type);
    const seenSession = readString(event.sessionID);
    if (sessionId === null && seenSession !== null && seenSession !== "") {
      sessionId = seenSession;
    }

    if (type === null || !KNOWN_EVENT_TYPES.has(type)) {
      // The one thing here worth writing down verbatim (issue #165).
      recorder.streamEvent(taskId, event);
      return;
    }

    const part = isRecord(event.part) ? event.part : null;

    switch (type) {
      case "text": {
        const text = part === null ? null : readString(part.text);
        if (text === null || text === "") return;
        finalMessage = text;
        insert("agent", "text", { text });
        return;
      }
      case "tool_use": {
        const row = part === null ? null : describeToolPart(part);
        if (row === null) {
          recorder.streamEvent(taskId, event);
          return;
        }
        insert("agent", "tool_use", row);
        return;
      }
      case "step_finish": {
        if (part === null) return;
        const step = readStepUsage(part);
        if (step !== null) usage = addUsage(usage, step);
        const cost = readCount(part.cost);
        if (cost !== null) costUsd += cost;
        return;
      }
      case OPENCODE_ERROR_EVENT: {
        const error = readOpenCodeError(event);
        if (error === null) {
          // Not by type: `error` is one of Claude Code's known types too, and
          // the recorder would drop it (module note).
          recorder.unparseableLine(taskId, JSON.stringify(event));
          return;
        }
        lastErrorEvent = event;
        lastError = error;
        systemNote(`Error: ${error.message ?? error.name ?? "Unknown error"}`);
        return;
      }
      case OPENCODE_TURN_EXIT_EVENT: {
        // The last error rides with the exit so the recorder's pass-exit
        // record (`runTurn`) keeps the refusal's body verbatim (issue #165).
        terminal = lastErrorEvent === null ? event : { ...event, lastError: lastErrorEvent };
        // The cached share is named beside the input total (issue #225): a
        // lane prices cache reads separately, and how much of a pass was
        // cache reads is the figure that tells the native path from the
        // Anthropic-skin path on the same model — it was only readable out of
        // the session database before this line carried it.
        const tokens =
          usage === null
            ? "no token usage reported"
            : `${usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens} input tokens` +
              cacheDetail(usage) +
              `, ${usage.outputTokens} output tokens`;
        // The CLI's own estimate, which on a lane that declares prices is not
        // what the turn is charged (issue #175) — `runTurn` adds the lane's
        // number beside this line when the two differ.
        systemNote(`Turn complete (${tokens}; CLI estimate $${costUsd.toFixed(4)})`);
        if (onDone) onDone();
        return;
      }
      default:
        // `step_start` and `reasoning`: nothing to render.
        return;
    }
  };

  const parseLine = (line: string): void => {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      // Not JSON: the CLI's stderr, merged into the stream. Kept verbatim and
      // shown on the feed, exactly as the other parsers do.
      recorder.unparseableLine(taskId, line);
      systemNote(line);
      return;
    }
    if (isRecord(event)) handleEvent(event);
    else recorder.unparseableLine(taskId, line);
  };

  return {
    onDone(cb: () => void) {
      onDone = cb;
    },

    write(chunk: Buffer | string): void {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) parseLine(trimmed);
      }
    },

    flush(): TurnResult {
      if (buffer.trim()) {
        parseLine(buffer.trim());
        buffer = "";
      }
      return {
        sessionId,
        costUsd,
        finalMessage,
        outcome: classifyOpenCodeExit(terminal, lastError),
        terminalResult: terminal,
        // No quota telemetry on this wire (the descriptor says so).
        rateLimit: null,
        usage,
      };
    },
  };
}
