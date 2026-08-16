/**
 * The live view's read model (issue #121). `toChatView(messages)` is pure:
 * every stored message row goes in, a discriminated view-model comes out, and
 * the React pieces downstream are dumb renderers that switch on `kind`.
 *
 * The shape encodes the signed-off design rather than the storage: an owner
 * turn is a short instruction (`user-chip`), an agent turn is a document
 * (`agent-markdown`), and a tool call is a quiet, skimmable row (`tool-event`)
 * that can be expanded. Deciding which is which — and deriving a tool row's
 * one right-aligned metric and its diff — is exactly the logic worth testing,
 * so it lives here and not in a component.
 */

/** A message row as stored in the DB and streamed over SSE. */
export interface ChatMessageRow {
  id: string;
  role: string;
  type: string;
  content: string;
}

export interface UserChipItem {
  kind: "user-chip";
  id: string;
  text: string;
}

export interface AgentMarkdownItem {
  kind: "agent-markdown";
  id: string;
  markdown: string;
}

export interface SystemNoteItem {
  kind: "system-note";
  id: string;
  text: string;
}

/** Line-level diff of an edit, shown when a tool row is expanded. */
export interface ToolDiff {
  removed: string[];
  added: string[];
}

export interface ToolEventItem {
  kind: "tool-event";
  id: string;
  /** What the agent did — the tool's own name (Read, Bash, Edit). */
  verb: string;
  /** The one thing it did it to: a path, a command, a pattern. */
  argument: string | null;
  /** The single right-aligned metric: `+3 −1`, `42 lines`. Null when the row
   * has nothing countable yet (a tool call still awaiting its result). */
  metric: string | null;
  /** The call's input, as text, for the expanded row. Null when the diff
   * already says everything the input would. */
  detail: string | null;
  diff: ToolDiff | null;
  output: string | null;
  /** True when `output` was clipped — the row says so rather than implying
   * the agent's tool returned this much and no more. */
  outputTruncated: boolean;
}

export type ChatViewItem =
  | UserChipItem
  | AgentMarkdownItem
  | SystemNoteItem
  | ToolEventItem;

/** Output kept per tool row. Enough to read a build failure; short enough that
 * a thousand-line `Read` result can't wedge the transcript. */
const MAX_OUTPUT_CHARS = 4000;

/** Tools whose work is a file write, so the metric is `+n −m`, not lines read. */
const EDIT_TOOLS = new Set(["Edit", "edit", "MultiEdit", "Write", "write"]);

/**
 * Legacy rows from Phase 2a stored the raw text rather than a JSON envelope,
 * and a truncated write can still leave one behind, so unparseable content is
 * read as plain text instead of being dropped.
 */
function parseContent(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : { text: content };
  } catch {
    return { text: content };
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Presence of the `text` key, not its truthiness: an envelope that says the
 * message is empty means it, and must not fall back to showing its own JSON. */
function text(parsed: Record<string, unknown>, fallback: string): string {
  return typeof parsed.text === "string" ? parsed.text : fallback;
}

/** A trailing newline ends the last line rather than starting a new one, and
 * an empty string is no lines at all — not one blank one. */
function splitLines(value: string): string[] {
  if (value === "") return [];
  const lines = value.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function lineCount(value: string): number {
  return splitLines(value).length;
}

/** The argument is the one thing the row names: a path, a command, a pattern.
 * Order matters — `file_path` first, because that is what a reader scans for. */
function toolArgument(
  filePath: string | null,
  input: Record<string, unknown>
): string | null {
  return (
    filePath ??
    asString(input.file_path) ??
    asString(input.command) ??
    asString(input.pattern) ??
    asString(input.path) ??
    asString(input.url) ??
    asString(input.description) ??
    asString(input.prompt)
  );
}

/**
 * Only the lines that actually changed. An edit's strings carry whatever
 * context the agent needed to match on, so counting them whole would report a
 * one-character fix as `+3 −3` — not what `+n −m` means to anyone who has read
 * a git diff. Trimming the common head and tail leaves the real change, and
 * the expanded row then shows exactly what the metric counted.
 */
function changedLines(oldString: string, newString: string): ToolDiff {
  const removed = splitLines(oldString);
  const added = splitLines(newString);

  let head = 0;
  while (head < removed.length && head < added.length && removed[head] === added[head]) {
    head++;
  }

  let tail = 0;
  while (
    tail < removed.length - head &&
    tail < added.length - head &&
    removed[removed.length - 1 - tail] === added[added.length - 1 - tail]
  ) {
    tail++;
  }

  return {
    removed: removed.slice(head, removed.length - tail),
    added: added.slice(head, added.length - tail),
  };
}

function toolDiff(
  verb: string,
  input: Record<string, unknown>
): ToolDiff | null {
  if (!EDIT_TOOLS.has(verb)) return null;

  // MultiEdit applies several edits to one file in one call, so its row
  // reports their sum rather than nothing at all.
  const edits = Array.isArray(input.edits) ? input.edits : null;
  if (edits) {
    const diffs = edits
      .filter((edit): edit is Record<string, unknown> => !!edit && typeof edit === "object")
      .map((edit) =>
        changedLines(asString(edit.old_string) ?? "", asString(edit.new_string) ?? "")
      );
    return {
      removed: diffs.flatMap((d) => d.removed),
      added: diffs.flatMap((d) => d.added),
    };
  }

  const oldString = asString(input.old_string);
  const newString = asString(input.new_string);
  if (oldString !== null || newString !== null) {
    return changedLines(oldString ?? "", newString ?? "");
  }

  // Write: the whole file is the addition.
  const content = asString(input.content);
  if (content !== null) return { removed: [], added: splitLines(content) };

  return null;
}

/** One metric, right-aligned: a write counts lines changed, everything else
 * counts what came back. Null while a call is still in flight.
 *
 * The typographic minus is deliberate — this is a stat, set in the same
 * tabular mono as the header's money, not the ASCII `-` gutter of the diff
 * the row expands to. */
function toolMetric(diff: ToolDiff | null, output: string | null): string | null {
  if (diff) return `+${diff.added.length} −${diff.removed.length}`;
  if (output === null) return null;
  const lines = lineCount(output);
  return `${lines} line${lines === 1 ? "" : "s"}`;
}

/** Everything the expanded row shows beyond the diff and the output. A Bash
 * command reads as a command; anything else is shown as its raw input, which
 * beats inventing a per-tool layout for tools we have never seen. */
function toolDetail(
  argument: string | null,
  diff: ToolDiff | null,
  input: Record<string, unknown>
): string | null {
  const command = asString(input.command);
  if (command !== null) return `$ ${command}`;
  if (diff) return null;

  // Whatever the row already says is not worth repeating in its expansion.
  const rest = Object.fromEntries(
    Object.entries(input).filter(
      ([key, value]) =>
        value !== undefined && key !== "file_path" && value !== argument
    )
  );
  if (Object.keys(rest).length === 0) return null;
  return JSON.stringify(rest, null, 2);
}

function toToolEvent(id: string, parsed: Record<string, unknown>): ToolEventItem {
  const verb = asString(parsed.tool) ?? "tool";
  const input =
    parsed.input && typeof parsed.input === "object"
      ? (parsed.input as Record<string, unknown>)
      : {};
  // Presence, not truthiness: a tool that returned nothing has an empty
  // result and reads `0 lines`; a tool still running has no result at all.
  const rawOutput = typeof parsed.output === "string" ? parsed.output : null;
  const argument = toolArgument(asString(parsed.file_path), input);
  const diff = toolDiff(verb, input);
  const truncated = rawOutput !== null && rawOutput.length > MAX_OUTPUT_CHARS;

  return {
    kind: "tool-event",
    id,
    verb,
    argument,
    metric: toolMetric(diff, rawOutput),
    detail: toolDetail(argument, diff, input),
    diff,
    output: truncated ? rawOutput.slice(0, MAX_OUTPUT_CHARS) : rawOutput,
    outputTruncated: truncated,
  };
}

/**
 * Map stored messages to the transcript's view-model, in order.
 *
 * Empty text is dropped rather than rendered: the parser emits a row per
 * assistant content block, and an empty one would otherwise punch a hole in
 * the transcript that reads like something failed.
 */
export function toChatView(messages: ChatMessageRow[]): ChatViewItem[] {
  const items: ChatViewItem[] = [];

  for (const message of messages) {
    const parsed = parseContent(message.content);

    if (message.role === "system" || message.type === "system") {
      const note = text(parsed, message.content).trim();
      if (note) items.push({ kind: "system-note", id: message.id, text: note });
      continue;
    }

    if (message.role === "user") {
      const body = text(parsed, message.content).trim();
      if (body) items.push({ kind: "user-chip", id: message.id, text: body });
      continue;
    }

    if (message.type === "tool_use") {
      items.push(toToolEvent(message.id, parsed));
      continue;
    }

    const markdown = text(parsed, message.content).trim();
    if (markdown) {
      items.push({ kind: "agent-markdown", id: message.id, markdown });
    }
  }

  return items;
}
