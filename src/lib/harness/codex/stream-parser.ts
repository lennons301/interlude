import { db } from "@/db";
import { messages, tasks } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { newId } from "../../ulid";
import {
  getStreamRecorder,
  type StreamRecorder,
} from "../../orchestrator/stream-recorder";
import type { TurnTokenUsage } from "../../lanes/lane-cost";
import { describeTurnTokens } from "../turn-usage-prose";
import type { HarnessOutputHandler } from "../adapter";
import type { TurnResult } from "../turn-result";
import {
  classifyCodexExit,
  CODEX_TURN_COMPLETED,
  CODEX_TURN_FAILED,
  readFailureMessage,
} from "./outcome";

/**
 * Parse the Codex CLI's `codex exec --json` stream and insert messages into
 * the feed (issue #221) — the Codex adapter's own parser, as
 * `claude-code/stream-parser.ts` is Claude Code's. The orchestrator sees only
 * the `TurnResult` it hands back, whose `outcome` is the fleet's vocabulary
 * (`./outcome.ts`) and never this stream's.
 *
 * The stream is JSONL, one event per line, of these top-level types (recorded
 * against 0.153.4 — the fixtures beside the tests are the evidence):
 *
 * - `thread.started` `{ thread_id }`: the session id, which `codex exec resume`
 *   takes; re-emitted with the same id on a resumed turn.
 * - `turn.started`: nothing to read.
 * - `item.started` / `item.updated` / `item.completed` `{ item }`: the turn's
 *   work, one item per agent message, tool call or patch, each with a `type`
 *   (below) and an `id` the lifecycle is keyed on.
 * - `turn.completed` `{ usage }`: the terminal event of a finished turn.
 * - `turn.failed` `{ error: { message } }`: the terminal event of a failed one.
 * - `error` `{ message }`: the CLI's running commentary — a retry, a transport
 *   fallback — and, at a failure, the same sentence `turn.failed` then repeats.
 *
 * Items map onto the stored message shapes the transcript renders
 * (`toChatView`): an `agent_message` is an agent text row; `command_execution`,
 * `file_change`, `mcp_tool_call`, `web_search` and `todo_list` are tool rows,
 * inserted when the item starts (so the live view shows the running command)
 * and given their output when it completes, exactly as Claude Code's
 * `tool_use` row is updated by its `tool_result`; `reasoning` is dropped as a
 * thinking block is; an `error` item is a system note. The tool row's `tool`
 * is a readable name for the item kind and its `input` carries the item's
 * fields under the keys the transcript's argument rule already reads
 * (`command`, `file_path`, `query`), so a Codex shell command renders as a
 * Claude Bash call does — one transcript, whoever is on the other end.
 *
 * **Usage is cumulative on the wire, per turn in the result.** The CLI's
 * `turn.completed.usage` is the *thread's* running total — measured: a resumed
 * turn that spent 100 input tokens reported 4200, the prior turn's 4100 plus
 * its own — so charging it as the turn's would bill a resumed pass, or a chat's
 * every follow-up, for the whole conversation again. The turn's own usage is
 * therefore the difference from the total the thread had reached before it,
 * and that prior total is kept where a restart cannot lose it: on the feed, in
 * the turn-complete system note this parser writes (`codexThreadUsage`, the
 * wire's own shape, verbatim), read back at `thread.started` as the *largest*
 * total on any such note of any task row sharing the thread's session id —
 * the same task on a follow-up turn, the paused predecessor on a resume
 * (`tasks.sessionId` is carried onto the resumed row). The largest rather than
 * the newest because a thread's total only grows, so the largest is the latest
 * whatever the notes' clocks say — two rows written in one millisecond, or a
 * predecessor's clock ahead of ours, cannot pick the wrong one. A thread the
 * feed has never seen charges its total, which for a fresh thread *is* the
 * turn. A failed turn writes no note, so its tokens fall into the next turn's
 * difference — the direction that over-states, which is the safe half of that
 * trade. A total *below* the prior one on any count is charged whole for the
 * same reason: a cumulative total never goes down, so a smaller one is a
 * counter that restarted and the prior total says nothing about this turn —
 * where a difference floored at zero would book nothing against the metered
 * cap, the under-reporting #175 refuses, and would do so on every follow-up
 * were an unpinned CLI release ever to report per-turn usage instead. After a
 * restart the largest-note rule keeps charging whole until the new counter
 * passes the old high-water mark — bounded over-reporting, the accepted side.
 *
 * **What reaches the recorder (issue #165).** The recorder's allowlist is the
 * Claude Code parser's vocabulary, and it caps each event type at a handful of
 * records per turn; forwarding every Codex event, as that parser does, would
 * fill the cap with `item.completed` on every turn and hide the one thing
 * worth writing down — an item kind this build has not met — inside a
 * recognised envelope. So this parser forwards only what it did not act on: an
 * unknown top-level event, or an `item.*` whose item type it does not know.
 * A line that is not JSON at all is handed over as before, and noted on the
 * feed, because it is the CLI's stderr (merged into the stream) saying
 * something went wrong at startup.
 *
 * The CLI reports no dollar figure (the adapter declares no `reportsCost`), so
 * `costUsd` is zero and the lane's own prices charge the turn (`runTurn`, issue
 * #175) — the parser enforces that a metered Codex lane declares them.
 */

/** The item kinds this build renders, by their wire names. */
const AGENT_MESSAGE = "agent_message";
const REASONING = "reasoning";
const COMMAND_EXECUTION = "command_execution";
const FILE_CHANGE = "file_change";
const MCP_TOOL_CALL = "mcp_tool_call";
const WEB_SEARCH = "web_search";
const TODO_LIST = "todo_list";
const ERROR_ITEM = "error";

/** The key the turn-complete note keeps the thread's running total under. */
export const THREAD_USAGE_KEY = "codexThreadUsage";

/** How many of a thread's newest system notes are read looking for its
 * running total. A turn writes one; the rest of a task's system notes are the
 * orchestrator's few lines per turn, so this is generous. */
const LEDGER_SCAN_LIMIT = 200;

/**
 * The CLI's usage object, in the wire's own field names — the thread's running
 * total at the moment it was reported (see the module note). `input_tokens`
 * includes the cached tokens, as the Responses API counts them: measured, three
 * API calls of 1200/1400/1500 input with 1000/1200/1300 cached summed to
 * `input_tokens: 4100, cached_input_tokens: 3500`. It includes the
 * cache-*written* tokens too — the two cache counts are the Responses API's
 * `input_tokens_details`, a breakdown of `input_tokens`, not additions to it
 * (measured on the proof ticket, #224: a turn reported `input_tokens: 71076`
 * = 56233 cached + 14828 cache-written + 15 plain, to the token).
 */
export interface CodexThreadUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

const USAGE_KEYS: readonly (keyof CodexThreadUsage)[] = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * A usage object off the wire, or null when it does not carry the two counts a
 * turn cannot be priced without. The cache and reasoning counts default to zero
 * when absent: a build of the CLI before `cache_write_input_tokens` existed
 * reported a turn without it, not a turn with no input.
 */
export function readThreadUsage(value: unknown): CodexThreadUsage | null {
  if (!isRecord(value)) return null;
  const input = readCount(value.input_tokens);
  const output = readCount(value.output_tokens);
  if (input === null || output === null) return null;
  return {
    input_tokens: input,
    output_tokens: output,
    cached_input_tokens: readCount(value.cached_input_tokens) ?? 0,
    cache_write_input_tokens: readCount(value.cache_write_input_tokens) ?? 0,
    reasoning_output_tokens: readCount(value.reasoning_output_tokens) ?? 0,
  };
}

/**
 * The turn's own usage, in the fleet's shape, from the thread's total at the
 * end of the turn and the total it had reached before it (null for a thread
 * never seen). Each count is the difference — unless any count went *down*,
 * which a cumulative total never does: that is a counter the CLI restarted,
 * the prior total says nothing about this turn, and the new total is charged
 * whole. Charging the whole total is the over-stating side; a difference
 * floored at zero would be the under-reporting one (see the module note).
 * `inputTokens` is the *plain* input: the wire's `input_tokens` includes both
 * the cache-read and the cache-written tokens (see `CodexThreadUsage`), and
 * the fleet's shape counts each apart so a lane's rate card charges every
 * token once, at its own rate. Before the proof ticket (#224) only the reads
 * were subtracted, so a cold turn's cache-written tokens were charged twice —
 * once as input and again as cache writes, 2.25x the input rate on the
 * shipped lane; measured, a 71k-token turn was booked $0.0884 where the rate
 * card says $0.0588. Output tokens include reasoning tokens, as the wire's do.
 */
export function turnUsageFromThread(
  after: CodexThreadUsage,
  before: CodexThreadUsage | null
): TurnTokenUsage {
  const prior =
    before !== null && USAGE_KEYS.every((key) => after[key] >= before[key]) ? before : null;
  const delta = (key: keyof CodexThreadUsage) => after[key] - (prior?.[key] ?? 0);
  const input = delta("input_tokens");
  const cached = delta("cached_input_tokens");
  const written = delta("cache_write_input_tokens");
  return {
    inputTokens: Math.max(0, input - cached - written),
    outputTokens: delta("output_tokens"),
    cacheReadTokens: cached,
    cacheWriteTokens: written,
  };
}

/** The scalar a thread's totals are ordered by: they only ever grow. */
function totalTokens(usage: CodexThreadUsage): number {
  return USAGE_KEYS.reduce((sum, key) => sum + usage[key], 0);
}

/**
 * The thread's running total as of its last completed turn — the largest any
 * turn-complete note records for it (see the module note) — read off the feed,
 * or null when no task sharing this session id has such a note.
 */
export function readThreadUsageBefore(threadId: string): CodexThreadUsage | null {
  const rows = db
    .select({ content: messages.content })
    .from(messages)
    .innerJoin(tasks, eq(tasks.id, messages.taskId))
    .where(
      and(
        eq(tasks.sessionId, threadId),
        eq(messages.role, "system"),
        eq(messages.type, "system")
      )
    )
    .orderBy(desc(messages.createdAt))
    .limit(LEDGER_SCAN_LIMIT)
    .all();
  let largest: CodexThreadUsage | null = null;
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.content) as Record<string, unknown>;
      const usage = readThreadUsage(parsed?.[THREAD_USAGE_KEY]);
      if (usage !== null && (largest === null || totalTokens(usage) > totalTokens(largest))) {
        largest = usage;
      }
    } catch {
      // Not JSON: an early system note. Not a ledger line either way.
    }
  }
  return largest;
}

/** What a tool row shows for one item: the transcript's own content keys. */
interface ToolRow {
  tool: string;
  file_path?: string;
  input: Record<string, unknown>;
  /** The item's result text, once it has one. Absent while it runs. */
  output?: string;
  exit_code?: number | null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * A tool item as a feed row. Null for an item kind this build does not render
 * as a tool (an agent message, reasoning, an error item — each handled apart)
 * — and for an unknown kind a generic row, so nothing the agent did goes
 * missing from the transcript while the recorder keeps the event verbatim.
 */
export function describeToolItem(
  item: Record<string, unknown>,
  completed: boolean
): ToolRow | null {
  const type = readString(item.type);
  switch (type) {
    case COMMAND_EXECUTION: {
      const command = readString(item.command) ?? "";
      const row: ToolRow = { tool: "Shell", input: { command } };
      if (completed) {
        row.output = readString(item.aggregated_output) ?? "";
        row.exit_code = typeof item.exit_code === "number" ? item.exit_code : null;
      }
      return row;
    }
    case FILE_CHANGE: {
      const changes = Array.isArray(item.changes)
        ? (item.changes as unknown[]).filter(isRecord)
        : [];
      const first = changes.length > 0 ? readString(changes[0].path) : null;
      const row: ToolRow = { tool: "Patch", input: { changes } };
      if (first !== null) row.file_path = first;
      if (completed) {
        row.output = changes
          .map((change) => `${readString(change.kind) ?? "change"} ${readString(change.path) ?? ""}`.trim())
          .join("\n");
      }
      return row;
    }
    case MCP_TOOL_CALL: {
      const server = readString(item.server) ?? "mcp";
      const tool = readString(item.tool) ?? "tool";
      const row: ToolRow = {
        tool: `${server}.${tool}`,
        input: isRecord(item.arguments) ? item.arguments : {},
      };
      if (completed) {
        const result = item.error ?? item.result;
        row.output = result === undefined || result === null ? "" : JSON.stringify(result, null, 2);
      }
      return row;
    }
    case WEB_SEARCH: {
      const row: ToolRow = { tool: "WebSearch", input: { query: readString(item.query) ?? "" } };
      if (completed) row.output = "";
      return row;
    }
    case TODO_LIST: {
      const items = Array.isArray(item.items) ? (item.items as unknown[]).filter(isRecord) : [];
      const row: ToolRow = { tool: "Plan", input: { items } };
      if (completed) {
        row.output = items
          .map((entry) => `[${entry.completed === true ? "x" : " "}] ${readString(entry.text) ?? ""}`)
          .join("\n");
      }
      return row;
    }
    case AGENT_MESSAGE:
    case REASONING:
    case ERROR_ITEM:
    case null:
      return null;
    default: {
      // Never met this kind: render what it carries rather than nothing.
      const { id: _id, type: _type, status: _status, ...rest } = item;
      void _id; void _type; void _status;
      const row: ToolRow = { tool: type, input: rest };
      if (completed) row.output = "";
      return row;
    }
  }
}

const KNOWN_ITEM_TYPES: ReadonlySet<string> = new Set([
  AGENT_MESSAGE,
  REASONING,
  COMMAND_EXECUTION,
  FILE_CHANGE,
  MCP_TOOL_CALL,
  WEB_SEARCH,
  TODO_LIST,
  ERROR_ITEM,
]);

export function createOutputHandler(
  taskId: string,
  /** Injectable so the recorder can be observed in tests without a filesystem;
   * production always takes the process-wide one. */
  recorder: StreamRecorder = getStreamRecorder(),
  /** The clock a wall's stated reset is read against (`./outcome.ts`). */
  now: () => Date = () => new Date()
): HarnessOutputHandler & { write(chunk: Buffer | string): void } {
  let buffer = "";
  let sessionId: string | null = null;
  let lastText: string | null = null;
  let terminal: Record<string, unknown> | null = null;
  let usage: TurnTokenUsage | null = null;
  let usageBefore: CodexThreadUsage | null = null;
  let lastErrorMessage: string | null = null;
  /** Feed row per in-flight tool item, by the item's id. */
  const toolRows = new Map<string, string>();
  let onDone: (() => void) | null = null;

  const insert = (
    role: "agent" | "system",
    type: "text" | "tool_use" | "system",
    content: object
  ): string => {
    const id = newId();
    db.insert(messages)
      .values({ id, taskId, role, type, content: JSON.stringify(content), createdAt: now() })
      .run();
    return id;
  };

  const systemNote = (text: string, extra: Record<string, unknown> = {}) =>
    insert("system", "system", { text, ...extra });

  const handleItem = (event: Record<string, unknown>, completed: boolean): void => {
    const item = event.item;
    if (!isRecord(item)) return;
    const type = readString(item.type);
    if (type === null || !KNOWN_ITEM_TYPES.has(type)) {
      // The one thing here worth writing down verbatim (issue #165).
      recorder.streamEvent(taskId, event);
    }

    if (type === AGENT_MESSAGE) {
      // The whole text arrives on completion; nothing is rendered before it.
      if (!completed) return;
      const text = readString(item.text);
      if (text === null || text === "") return;
      lastText = text;
      insert("agent", "text", { text });
      return;
    }
    if (type === REASONING) return;
    if (type === ERROR_ITEM) {
      if (!completed) return;
      systemNote(`Error: ${readString(item.message) ?? "Unknown error"}`);
      return;
    }

    const row = describeToolItem(item, completed);
    if (row === null) return;
    const itemId = readString(item.id) ?? newId();
    const existing = toolRows.get(itemId);
    if (existing === undefined) {
      const id = insert("agent", "tool_use", row);
      if (!completed) toolRows.set(itemId, id);
      return;
    }
    db.update(messages)
      .set({ content: JSON.stringify(row), updatedAt: now() })
      .where(eq(messages.id, existing))
      .run();
    if (completed) toolRows.delete(itemId);
  };

  const handleEvent = (event: Record<string, unknown>): void => {
    const type = readString(event.type);
    switch (type) {
      case "thread.started": {
        const threadId = readString(event.thread_id);
        if (threadId !== null && threadId !== "") {
          sessionId = threadId;
          usageBefore = readThreadUsageBefore(threadId);
        }
        return;
      }
      case "turn.started":
        return;
      case "item.started":
      case "item.updated":
        handleItem(event, false);
        return;
      case "item.completed":
        handleItem(event, true);
        return;
      case CODEX_TURN_COMPLETED: {
        terminal = event;
        const total = readThreadUsage(event.usage);
        if (total !== null) {
          usage = turnUsageFromThread(total, usageBefore);
          systemNote(
            // The tokens clause is the fleet's one shape (`turn-usage-prose.ts`),
            // so this feed cannot drift from another harness's by copy.
            `Turn complete (${describeTurnTokens(usage)})`,
            // The thread's running total, for the next turn's difference — see
            // the module note.
            { [THREAD_USAGE_KEY]: total }
          );
        } else {
          systemNote("Turn complete");
        }
        onDone?.();
        return;
      }
      case CODEX_TURN_FAILED: {
        terminal = event;
        const message = readFailureMessage(event);
        // The CLI says the sentence twice — once as `error`, once here — and
        // the feed needs it once.
        if (message !== null && message !== lastErrorMessage) systemNote(`Error: ${message}`);
        onDone?.();
        return;
      }
      case "error": {
        const message = readString(event.message) ?? "Unknown error";
        lastErrorMessage = message;
        systemNote(`Error: ${message}`);
        return;
      }
      default:
        // An event this build has not met: written down verbatim (issue #165)
        // rather than dropped.
        recorder.streamEvent(taskId, event);
    }
  };

  const parseLine = (line: string): void => {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      // Not JSON: the CLI's stderr, merged into the stream. Kept as evidence
      // and shown, because at startup it is the only thing that explains a
      // turn that never began.
      recorder.unparseableLine(taskId, line);
      systemNote(line);
      return;
    }
    if (!isRecord(event)) return;
    try {
      handleEvent(event);
    } catch (err) {
      // Total on the hot path, as the Claude Code parser is: a feed write that
      // failed loses one row, never the turn's remaining stream.
      console.error(`[codex] Failed to handle a stream event for task ${taskId}:`, err);
    }
  };

  return {
    onDone(callback) {
      onDone = callback;
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
        // No dollar figure on this wire (the adapter declares no cost
        // reporting); the lane's prices charge the turn in `runTurn`.
        costUsd: 0,
        finalMessage: lastText,
        outcome: classifyCodexExit(terminal, now()),
        terminalResult: terminal,
        // The exec stream carries no quota telemetry — see `./outcome.ts`.
        rateLimit: null,
        usage,
      };
    },
  };
}
