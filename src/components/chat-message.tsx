"use client";

import { useMemo } from "react";
import type { ChatViewItem } from "@/lib/chat/chat-view";
import { renderMarkdown } from "@/lib/chat/markdown";
import { ToolCard } from "./tool-card";

/**
 * The transcript's renderers (issue #121) — dumb by design: every decision
 * about what a stored row *is* was made by `toChatView`, so this file only
 * knows how each kind looks.
 *
 * The hybrid asymmetry is deliberate and signed off: an owner turn is a short
 * instruction and renders as a compact right-aligned chip; an agent turn is a
 * document and renders full-width. They are not peers in a chat app.
 */
export function ChatMessage({ item }: { item: ChatViewItem }) {
  switch (item.kind) {
    case "user-chip":
      return <UserChip text={item.text} />;
    case "agent-markdown":
      return <AgentMarkdown markdown={item.markdown} />;
    case "tool-event":
      return <ToolCard event={item} />;
    case "system-note":
      return <SystemNote text={item.text} />;
  }
}

function UserChip({ text }: { text: string }) {
  return (
    <div className="flex justify-end py-1.5">
      <div className="max-w-[80%] rounded-[4px] border border-fl-line-strong bg-fl-card px-3 py-1.5 text-[13px] whitespace-pre-wrap text-fl-ink">
        {text}
      </div>
    </div>
  );
}

/**
 * The HTML is produced by the pipeline in `src/lib/chat/markdown.ts`, which
 * escapes raw HTML to text and then runs it through rehype-sanitize's
 * allowlist — so what lands here is markup this app generated, and injecting
 * it is what lets the document be styled as one (`.fleet-md` in globals.css).
 * Read that module before changing this: the safety argument lives there.
 *
 * Memoized on the source, because the transcript re-renders on every streamed
 * message and re-parsing every earlier turn each time would not scale.
 */
function AgentMarkdown({ markdown }: { markdown: string }) {
  const html = useMemo(() => renderMarkdown(markdown), [markdown]);

  return (
    <div
      className="fleet-md py-1.5"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function SystemNote({ text }: { text: string }) {
  return (
    <div className="flex justify-center py-1.5">
      <span className="font-plex-mono text-[11px] text-fl-ink-3">{text}</span>
    </div>
  );
}
