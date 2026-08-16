"use client";

import { useState } from "react";
import { FOCUS_RING } from "@/components/fleet/fleet-bits";
import type { ToolEventItem } from "@/lib/chat/chat-view";

/**
 * A tool event (issue #121). Quiet by default and collapsed: one row carrying
 * the verb, its argument and a single right-aligned metric. The bar for this
 * row is that it can be ignored while skimming and still read without being
 * expanded — a transcript is mostly tool calls, and if each one is a card the
 * agent's actual reasoning disappears between them.
 *
 * Expanding reveals the call's input and output, and an edit reveals its diff.
 */
export function ToolCard({ event }: { event: ToolEventItem }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = Boolean(
    event.detail || event.diff || (event.output && event.output.length > 0)
  );

  return (
    <div className="py-0.5">
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        disabled={!hasDetail}
        aria-expanded={hasDetail ? expanded : undefined}
        className={`flex w-full items-baseline gap-2 rounded-[3px] py-0.5 text-left font-plex-mono text-[12px] ${FOCUS_RING} ${
          hasDetail ? "hover:bg-fl-surface" : "cursor-default"
        }`}
      >
        <span
          aria-hidden
          className={`shrink-0 text-fl-ink-3 transition-transform ${
            expanded ? "rotate-90" : ""
          } ${hasDetail ? "" : "opacity-0"}`}
        >
          ›
        </span>
        <span className="shrink-0 font-medium text-fl-ink-2">{event.verb}</span>
        {event.argument && (
          <span className="min-w-0 flex-1 truncate text-fl-ink-3">
            {event.argument}
          </span>
        )}
        {event.metric && (
          <span className="ml-auto shrink-0 pl-2 tabular-nums text-fl-ink-3">
            {event.metric}
          </span>
        )}
      </button>

      {expanded && hasDetail && (
        <div className="mt-1 mb-1.5 ml-3.5 space-y-2 border-l border-fl-line pl-3">
          {event.detail && (
            <pre className="overflow-x-auto font-plex-mono text-[11px] whitespace-pre text-fl-ink-2">
              {event.detail}
            </pre>
          )}

          {event.diff && <Diff removed={event.diff.removed} added={event.diff.added} />}

          {event.output && (
            <pre className="max-h-56 overflow-auto font-plex-mono text-[11px] whitespace-pre-wrap text-fl-ink-3">
              {event.output}
              {event.outputTruncated && "\n… output clipped"}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** Removed and added lines, tinted rather than outlined: the sign is carried
 * by the gutter character as well as the colour, so it survives without it. */
function Diff({ removed, added }: { removed: string[]; added: string[] }) {
  return (
    <div className="overflow-x-auto font-plex-mono text-[11px] leading-[1.55]">
      {removed.map((line, i) => (
        <div key={`r${i}`} className="whitespace-pre bg-fl-red/12 text-fl-red">
          <span className="select-none opacity-70">- </span>
          {line}
        </div>
      ))}
      {added.map((line, i) => (
        <div key={`a${i}`} className="whitespace-pre bg-fl-green/12 text-fl-green">
          <span className="select-none opacity-70">+ </span>
          {line}
        </div>
      ))}
    </div>
  );
}
