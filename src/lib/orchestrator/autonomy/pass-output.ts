/**
 * Shared interpretation of an autonomous pass's turn result: the turn's final
 * message, taken only from a turn whose harness reported a clean finish — the
 * same normalised outcome the turn manager judges the pass by (issue #214) —
 * so a turn that never finished cleanly yields no message by construction.
 * The verdict and triage parsers both read their structured exits from this
 * one extraction.
 *
 * Read off the adapter's `TurnResult`, never the raw stream: before #214 this
 * module re-parsed one vendor's NDJSON for the `result` event and read its
 * error flag and subtype for itself, which made the review and triage exits a
 * contract with one vendor's stream. Now the adapter says how the turn ended
 * and what its final message was, and this asks nothing else.
 */

import type { TurnOutcome, TurnResult } from "../../harness/turn-result";

/** What the two exit readers need to know about a turn. */
export type PassTurn = Pick<TurnResult, "outcome" | "finalMessage">;

export type FinalPassMessage =
  | { ok: true; message: string }
  | { ok: false; reason: string };

/**
 * Whether the harness reported how the pass ended at all — the signal that
 * separates an infra death from a work failure (issue #97). An outcome, of any
 * kind, means the agent process ran to a terminal state (whatever it then
 * said, or however it errored): any parse failure downstream is the work's —
 * a format slip, an empty verdict. No outcome means the container exited
 * without finishing (OOM / exit 137, docker error, a lost stream), which is
 * the platform's fault, not the work's, so it must not be charged to the
 * attempt or format-retry budget.
 */
export function passProducedResult(turn: Pick<TurnResult, "outcome">): boolean {
  return turn.outcome !== null;
}

/** The outcome's kind, in words a feed line can carry. */
function describeOutcome(outcome: TurnOutcome): string {
  switch (outcome.kind) {
    case "turn-limit":
      return "turn limit reached";
    case "refused":
      return `refused: ${outcome.refusal.kind}`;
    case "failed":
      return outcome.reason ?? "harness error";
    case "completed":
      return "completed";
  }
}

export function finalPassMessage(turn: PassTurn): FinalPassMessage {
  if (turn.outcome === null) {
    return { ok: false, reason: "pass output has no result event" };
  }

  // A turn that did not complete (turn limit, a refusal, a harness error)
  // delivered no exit, whatever its last words were — the pass did not finish.
  if (turn.outcome.kind !== "completed") {
    return {
      ok: false,
      reason: `pass did not complete cleanly (${describeOutcome(turn.outcome)})`,
    };
  }

  const finalMessage = turn.finalMessage;
  if (typeof finalMessage !== "string" || !finalMessage.trim()) {
    return { ok: false, reason: "result event carries no final message" };
  }

  return { ok: true, message: finalMessage };
}
