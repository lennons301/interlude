/**
 * Test helper: what the Claude Code adapter would hand the orchestrator for a
 * recorded stream (issue #214).
 *
 * The review-verdict, triage-exit and pass-output suites keep their fixtures
 * as the NDJSON a real pass emits, because that is the evidence — but the
 * readers they test no longer take a stream, they take the adapter's
 * normalised `TurnResult`. This is the bridge: it finds the stream's terminal
 * `result` event and asks the adapter's own classifier what it means, so the
 * only code reading the vendor's exit shape is still the adapter's. Nothing
 * outside `src/test` should need it.
 */

import { classifyClaudeExit } from "@/lib/harness/claude-code/outcome";
import type { PassTurn } from "@/lib/orchestrator/autonomy/pass-output";

export function turnFromClaudeStream(ndjson: string): PassTurn {
  let terminal: Record<string, unknown> | null = null;
  let lastText: string | null = null;

  for (const line of ndjson.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue; // interleaved non-JSON noise, exactly as the parser skips it
    }
    if (event.type === "result") terminal = event;
    if (event.type === "assistant") {
      const message = event.message as { content?: unknown } | undefined;
      const blocks = Array.isArray(message?.content) ? message.content : [];
      for (const block of blocks as Array<{ type?: string; text?: string }>) {
        if (block.type === "text" && block.text) lastText = block.text;
      }
    }
  }

  const stated = terminal?.result;
  const finalMessage =
    typeof stated === "string" && stated.trim() !== "" ? stated : lastText;

  return { outcome: classifyClaudeExit(terminal, null), finalMessage };
}
