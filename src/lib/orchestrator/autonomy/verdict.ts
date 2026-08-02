/**
 * Verdict parsing for the review pass (issue #17) — pure interpretation of
 * a review container's stream-json output. The reviewer holds no credential
 * that can post a review; it *returns* a verdict, and trusted code acts on
 * it. An unparseable verdict is an error, not a maybe: the caller must never
 * treat it as an approval, and `decideNext` maps it to "block the merge and
 * tell the owner".
 *
 * The contract with the pass prompt: the turn's final message begins, on its
 * first line, with `VERDICT: approve | request-changes | escalate`, and the
 * rest of the message is the review body posted verbatim to GitHub.
 */

import { finalPassMessage } from "./pass-output";

export type ReviewVerdictKind = "approve" | "request-changes" | "escalate";

export type ReviewVerdictResult =
  | { kind: ReviewVerdictKind; body: string }
  | { kind: "unparseable"; reason: string };

const VERDICT_LINE = /^VERDICT:[ \t]*(approve|request-changes|escalate)[ \t]*$/i;

/**
 * The fix-up turn a request-changes verdict becomes: the reviewer's findings,
 * framed for the still-live implement container so the same attempt applies
 * them rather than a fresh one starting over.
 */
export function buildFeedbackTurn(prNumber: number, findings: string): string {
  return (
    `The reviewer requested changes on PR #${prNumber}:\n\n` +
    `${findings}\n\n` +
    `Address this feedback on the same branch: make the changes, keep the ` +
    `repo's tests and lint passing, and commit as you go. Finish with a ` +
    `short summary of what you changed.`
  );
}

/**
 * What a request-changes verdict becomes when the implement container is no
 * longer there to take the fix-up turn: an escalation carrying the findings,
 * so the review's work reaches a human instead of evaporating.
 */
export function undeliverableFeedbackBody(findings: string): string {
  return (
    `The review requested changes, but the implement container is no longer ` +
    `available to apply them — a human needs to pick this up.\n\n` +
    `${findings}`
  );
}

/**
 * Parse a review pass's raw NDJSON stream into a verdict. The final message
 * is taken from the terminal `result` event — the same signal the turn
 * manager treats as "turn complete" — so a stream that never finished
 * cleanly is unparseable by construction.
 */
export function parseReviewVerdict(ndjson: string): ReviewVerdictResult {
  const final = finalPassMessage(ndjson);
  if (!final.ok) {
    return { kind: "unparseable", reason: `review ${final.reason}` };
  }

  const lines = final.message.trim().split("\n");
  const match = lines[0].trim().match(VERDICT_LINE);
  if (!match) {
    return {
      kind: "unparseable",
      reason: "final message does not start with a VERDICT: line",
    };
  }

  const kind = match[1].toLowerCase() as ReviewVerdictKind;
  const body = lines.slice(1).join("\n").trim();

  // Findings with no content can drive neither a fix-up turn nor a human's
  // decision. Only an approval may stand on its marker alone.
  if (!body && kind !== "approve") {
    return { kind: "unparseable", reason: `${kind} verdict has no review body` };
  }

  return { kind, body };
}
