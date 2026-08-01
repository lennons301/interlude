/**
 * The blocked-marker detector (issue #19): a turn's final message -> the
 * question the agent is stuck on, or null. Pure — the deciding and executing
 * around it live in decide.ts and the turn manager.
 *
 * Detection is deliberately biased toward false negatives: the marker counts
 * only as the very first line of the message. A missed marker merely idles
 * the run where the dashboard shows it; a false positive parks healthy work.
 */

const BLOCKED_MARKER = /^BLOCKED:\s*(.*)$/;

export function detectBlockedQuestion(finalMessage: string | null): string | null {
  if (!finalMessage) return null;

  const firstLine = finalMessage.split("\n", 1)[0].replace(/\r$/, "");
  const match = firstLine.match(BLOCKED_MARKER);
  if (!match) return null;

  const question = match[1].trim();
  return question.length > 0 ? question : null;
}
