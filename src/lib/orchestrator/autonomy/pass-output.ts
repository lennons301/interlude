/**
 * Shared interpretation of an autonomous pass's raw stream-json output: the
 * turn's final message, taken from the terminal `result` event — the same
 * signal the turn manager treats as "turn complete" — so a stream that never
 * finished cleanly yields no message by construction. The verdict and triage
 * parsers both read their structured exits from this one extraction.
 */

export type FinalPassMessage =
  | { ok: true; message: string }
  | { ok: false; reason: string };

/**
 * Whether the pass emitted a terminal `result` event at all — the signal that
 * separates an infra death from a work failure (issue #97). A stream carrying
 * a result event means the agent process ran to a terminal state (whatever it
 * then said, or however it errored): any parse failure downstream is the
 * work's — a format slip, an empty verdict. No result event means the
 * container exited without finishing (OOM / exit 137, docker error, a lost
 * stream), which is the platform's fault, not the work's, so it must not be
 * charged to the attempt or format-retry budget.
 */
export function passProducedResult(ndjson: string): boolean {
  for (const line of ndjson.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      if (event.type === "result") return true;
    } catch {
      // Interleaved non-JSON output (stderr noise) is not the pass's problem
    }
  }
  return false;
}

export function finalPassMessage(ndjson: string): FinalPassMessage {
  let result: Record<string, unknown> | null = null;

  for (const line of ndjson.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      if (event.type === "result") result = event;
    } catch {
      // Interleaved non-JSON output (stderr noise) is not the pass's problem
    }
  }

  if (!result) {
    return { ok: false, reason: "pass output has no result event" };
  }

  // A turn that errored out (budget, max turns, execution failure) delivered
  // no exit, whatever its last words were — the pass did not finish.
  if (result.is_error === true || result.subtype !== "success") {
    return {
      ok: false,
      reason: `pass did not complete cleanly (${result.subtype ?? "unknown error"})`,
    };
  }

  const finalMessage = result.result;
  if (typeof finalMessage !== "string" || !finalMessage.trim()) {
    return { ok: false, reason: "result event carries no final message" };
  }

  return { ok: true, message: finalMessage };
}
