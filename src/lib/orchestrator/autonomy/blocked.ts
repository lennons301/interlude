/**
 * The blocked-marker detector (issue #19): a turn's final message -> the
 * question the agent is stuck on, or null. Pure — the deciding and executing
 * around it live in decide.ts and the turn manager.
 *
 * The marker counts at the **start of any line**, not just line 0 (issue #107).
 * "Narrate, then BLOCKED:" is extremely common LLM behaviour, and the earlier
 * first-line-only bias meant a leading preamble silently defeated the park: the
 * run was never blocked, the pass completed empty, and the owner never got the
 * Discord question — leaving a permanent non-terminal ghost (issue #106). A
 * false negative is therefore far more costly than the header once assumed, so
 * detection tolerates a preamble.
 *
 * The false-positive guards remain: the marker must begin a line (so mid-line
 * prose like "we were BLOCKED: by X" never matches) and lines inside a fenced
 * code block are skipped (so an agent quoting the protocol as an example does
 * not park itself). Only the rest of the marker's line is taken as the
 * question; further context stays in the task chat.
 */

const BLOCKED_MARKER = /^BLOCKED:\s*(.*)$/;
const CODE_FENCE = /^\s*(```|~~~)/;

export function detectBlockedQuestion(finalMessage: string | null): string | null {
  if (!finalMessage) return null;

  let insideFence = false;
  for (const rawLine of finalMessage.split("\n")) {
    const line = rawLine.replace(/\r$/, "");

    if (CODE_FENCE.test(line)) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) continue;

    const match = line.match(BLOCKED_MARKER);
    if (!match) continue;

    const question = match[1].trim();
    return question.length > 0 ? question : null;
  }

  return null;
}
