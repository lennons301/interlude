import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMessage } from "../chat-message";
import { toChatView, type ChatMessageRow } from "@/lib/chat/chat-view";

/**
 * The renderers are dumb, so there is little logic here to test — what these
 * cover is the contract the ticket states about the *rendered* transcript:
 * the hybrid asymmetry, that a fenced block arrives highlighted, that tool
 * rows start collapsed, and that raw HTML is inert on the real path a message
 * takes (row → toChatView → ChatMessage), not just in the pipeline in
 * isolation.
 */
function render(row: Partial<ChatMessageRow>): string {
  const items = toChatView([
    { id: "01", role: "agent", type: "text", content: "", ...row },
  ]);
  return items.map((item) => renderToStaticMarkup(<ChatMessage item={item} />)).join("");
}

const envelope = (value: unknown) => JSON.stringify(value);

describe("transcript rendering", () => {
  it("renders an owner turn as a compact right-aligned chip", () => {
    const html = render({ role: "user", content: envelope({ text: "colder" }) });

    expect(html).toContain("justify-end");
    expect(html).toContain("max-w-[80%]");
    expect(html).toContain("colder");
  });

  it("renders an agent turn full-width as a document", () => {
    const html = render({ content: envelope({ text: "## Options\n\n- one\n- two" }) });

    expect(html).toContain("fleet-md");
    expect(html).not.toContain("max-w-[80%]");
    expect(html).toContain("<h2>Options</h2>");
    expect(html).toContain("<li>one</li>");
  });

  it("renders a GFM table in an agent turn", () => {
    const html = render({ content: envelope({ text: "| a | b |\n| - | - |\n| 1 | 2 |" }) });

    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
  });

  it("highlights fenced code inside the transcript", () => {
    const html = render({ content: envelope({ text: "```ts\nconst x = 1;\n```" }) });

    expect(html).toContain("hljs-keyword");
    expect(html).toContain("<pre>");
  });

  it("renders raw HTML from the agent inert", () => {
    const html = render({
      content: envelope({ text: 'hi <script>alert(1)</script> <img src="x" onerror="alert(1)">' }),
    });

    expect(html).not.toMatch(/<\/?(script|img)[\s>/]/i);
    expect(html).toContain("alert(1)"); // shown as text, never executed
  });

  it("renders a tool event as one collapsed row with its metric", () => {
    const html = render({
      type: "tool_use",
      content: envelope({
        tool: "Read",
        file_path: "src/db/schema.ts",
        input: { file_path: "src/db/schema.ts" },
        output: "a\nb\nc",
      }),
    });

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Read");
    expect(html).toContain("src/db/schema.ts");
    expect(html).toContain("3 lines");
    // Collapsed means the output is not in the document at all.
    expect(html).not.toContain("a\nb\nc");
  });

  it("offers no expansion for a tool call with nothing to expand", () => {
    const html = render({
      type: "tool_use",
      content: envelope({ tool: "Read", file_path: "a.ts", input: { file_path: "a.ts" } }),
    });

    expect(html).not.toContain("aria-expanded");
    expect(html).toContain("disabled");
  });

  it("renders a system note quietly", () => {
    const html = render({
      role: "system",
      type: "system",
      content: envelope({ text: "Turn complete" }),
    });

    expect(html).toContain("Turn complete");
    expect(html).toContain("text-fl-ink-3");
  });
});

/**
 * The palette guard the ticket asks for by name. Both fleet themes are one
 * token set re-tuned per ground, so "renders in the fleet palette" is exactly
 * "carries no colour that is not a token" — a class from Tailwind's own
 * palette would be pinned to one theme and survive into the other.
 */
describe("fleet palette", () => {
  const FILES = [
    "src/components/chat-message.tsx",
    "src/components/tool-card.tsx",
    "src/components/task-stream.tsx",
    "src/components/task-chat.tsx",
  ];

  const OFF_PALETTE =
    /\b(?:bg|text|border|decoration|ring|outline|from|to|via|accent|fill|stroke|divide|placeholder|shadow)-(?:zinc|slate|gray|neutral|stone|purple|blue|green|amber|red|orange|yellow|indigo|violet|pink|emerald|teal|cyan|sky|lime|rose|fuchsia)-\d{2,3}\b/;

  for (const file of FILES) {
    it(`${file} uses fleet tokens only`, () => {
      const source = readFileSync(path.join(process.cwd(), file), "utf8");
      const offender = source.match(OFF_PALETTE);

      expect(offender?.[0] ?? null).toBeNull();
    });
  }
});
