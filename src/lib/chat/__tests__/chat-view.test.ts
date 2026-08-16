import { describe, expect, it } from "vitest";
import { toChatView, type ChatMessageRow } from "../chat-view";

function row(over: Partial<ChatMessageRow>): ChatMessageRow {
  return {
    id: "01",
    role: "agent",
    type: "text",
    content: JSON.stringify({ text: "hello" }),
    ...over,
  };
}

const json = (value: unknown) => JSON.stringify(value);

describe("toChatView", () => {
  const cases: Array<{
    name: string;
    row: ChatMessageRow;
    expected: Record<string, unknown>;
  }> = [
    {
      name: "owner text becomes a chip",
      row: row({ role: "user", content: json({ text: "make it colder" }) }),
      expected: { kind: "user-chip", text: "make it colder" },
    },
    {
      name: "agent text becomes markdown",
      row: row({ content: json({ text: "## Options\n\n1. one" }) }),
      expected: { kind: "agent-markdown", markdown: "## Options\n\n1. one" },
    },
    {
      name: "system row becomes a note",
      row: row({ role: "system", type: "system", content: json({ text: "Turn complete" }) }),
      expected: { kind: "system-note", text: "Turn complete" },
    },
    {
      name: "an agent row typed system is still a note",
      row: row({ role: "agent", type: "system", content: json({ text: "raw line" }) }),
      expected: { kind: "system-note", text: "raw line" },
    },
    {
      name: "legacy plain-text content (Phase 2a) is read as text",
      row: row({ content: "not json at all" }),
      expected: { kind: "agent-markdown", markdown: "not json at all" },
    },
    {
      name: "legacy plain-text from the owner is read as text",
      row: row({ role: "user", content: "ship it" }),
      expected: { kind: "user-chip", text: "ship it" },
    },
    {
      name: "non-object JSON content falls back to the raw string",
      row: row({ content: json("bare string") }),
      expected: { kind: "agent-markdown", markdown: '"bare string"' },
    },
    {
      name: "tool_use Read names the file and counts what came back",
      row: row({
        type: "tool_use",
        content: json({
          tool: "Read",
          file_path: "src/db/schema.ts",
          input: { file_path: "src/db/schema.ts" },
          output: "one\ntwo\nthree\n",
        }),
      }),
      expected: {
        kind: "tool-event",
        verb: "Read",
        argument: "src/db/schema.ts",
        metric: "3 lines",
        detail: null,
        diff: null,
        output: "one\ntwo\nthree\n",
        outputTruncated: false,
      },
    },
    {
      name: "tool_use Bash shows the command as the argument and as detail",
      row: row({
        type: "tool_use",
        content: json({
          tool: "Bash",
          input: { command: "pnpm test" },
          output: "ok",
        }),
      }),
      expected: {
        kind: "tool-event",
        verb: "Bash",
        argument: "pnpm test",
        metric: "1 line",
        detail: "$ pnpm test",
        diff: null,
      },
    },
    {
      name: "tool_use Edit counts lines changed and carries the diff",
      row: row({
        type: "tool_use",
        content: json({
          tool: "Edit",
          file_path: "src/app/page.tsx",
          input: {
            file_path: "src/app/page.tsx",
            old_string: "const a = 1",
            new_string: "const a = 1\nconst b = 2",
          },
          output: "Applied",
        }),
      }),
      expected: {
        kind: "tool-event",
        verb: "Edit",
        argument: "src/app/page.tsx",
        metric: "+2 −1",
        detail: null,
        diff: { removed: ["const a = 1"], added: ["const a = 1", "const b = 2"] },
      },
    },
    {
      name: "tool_use Write reads as a pure addition",
      row: row({
        type: "tool_use",
        content: json({
          tool: "Write",
          file_path: "notes.md",
          input: { file_path: "notes.md", content: "# Notes\n\nfirst\n" },
        }),
      }),
      expected: {
        kind: "tool-event",
        verb: "Write",
        argument: "notes.md",
        metric: "+3 −0",
        diff: { removed: [], added: ["# Notes", "", "first"] },
      },
    },
    {
      name: "a tool call still in flight has no metric",
      row: row({
        type: "tool_use",
        content: json({ tool: "Bash", input: { command: "pnpm build" } }),
      }),
      expected: { kind: "tool-event", metric: null, output: null },
    },
    {
      name: "a tool that returned nothing reads as zero lines, not in-flight",
      row: row({
        type: "tool_use",
        content: json({ tool: "Bash", input: { command: "true" }, output: "" }),
      }),
      expected: { kind: "tool-event", metric: "0 lines", output: "" },
    },
    {
      name: "an unrecognised tool still names its input in the expansion",
      row: row({
        type: "tool_use",
        content: json({
          tool: "Grep",
          input: { pattern: "TODO", path: "src" },
          output: "src/a.ts:1",
        }),
      }),
      expected: {
        kind: "tool-event",
        verb: "Grep",
        argument: "TODO",
        detail: '{\n  "path": "src"\n}',
      },
    },
    {
      name: "a malformed tool_use degrades to a bare row",
      row: row({ type: "tool_use", content: "{ truncated" }),
      expected: { kind: "tool-event", verb: "tool", argument: null, metric: null },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const [item] = toChatView([testCase.row]);
      expect(item).toMatchObject(testCase.expected);
    });
  }

  it("preserves order across roles", () => {
    const items = toChatView([
      row({ id: "01", role: "user", content: json({ text: "go" }) }),
      row({ id: "02", type: "tool_use", content: json({ tool: "Read", file_path: "a.ts", input: {} }) }),
      row({ id: "03", content: json({ text: "done" }) }),
      row({ id: "04", role: "system", type: "system", content: json({ text: "Turn complete" }) }),
    ]);

    expect(items.map((i) => [i.id, i.kind])).toEqual([
      ["01", "user-chip"],
      ["02", "tool-event"],
      ["03", "agent-markdown"],
      ["04", "system-note"],
    ]);
  });

  it("drops empty and whitespace-only text rather than punching a hole", () => {
    const items = toChatView([
      row({ id: "01", content: json({ text: "" }) }),
      row({ id: "02", role: "user", content: json({ text: "   \n " }) }),
      row({ id: "03", role: "system", type: "system", content: json({ text: "" }) }),
      row({ id: "04", content: json({ text: "kept" }) }),
    ]);

    expect(items).toEqual([{ kind: "agent-markdown", id: "04", markdown: "kept" }]);
  });

  it("clips a huge tool output and says so", () => {
    const [item] = toChatView([
      row({
        type: "tool_use",
        content: json({ tool: "Read", input: {}, output: "x".repeat(9000) }),
      }),
    ]);

    expect(item).toMatchObject({ kind: "tool-event", outputTruncated: true });
    expect(item.kind === "tool-event" && item.output?.length).toBe(4000);
  });

  it("is pure — the same rows map to the same view twice", () => {
    const rows = [row({ role: "user", content: json({ text: "hi" }) })];
    expect(toChatView(rows)).toEqual(toChatView(rows));
  });

  it("maps an empty transcript to an empty view", () => {
    expect(toChatView([])).toEqual([]);
  });
});
