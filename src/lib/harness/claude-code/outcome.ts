/**
 * How a Claude Code turn ended, in the fleet's vocabulary (issue #214).
 *
 * This is the one place the CLI's exit vocabulary is read. Before this ticket
 * it was read in three: the turn manager knew `error_max_turns` meant
 * exhaustion, `rate-limit-rejection.ts` knew a quota wall was `is_error` beside
 * a 429, and the pass-output reader knew a clean finish was `subtype:
 * "success"` without the error flag. Each was right, and together they were a
 * contract no second harness could be written against. They are folded into
 * `classifyClaudeExit` and the rest of the fleet branches on what it returns.
 *
 * Two findings from the #165 spike shape the classifier and are pinned by its
 * tests:
 *
 *  - **A quota rejection reports `subtype: "success"`.** Only `is_error`,
 *    `terminal_reason` and `api_error_status` separate it from a clean finish,
 *    which is why the terminal event is read whole rather than by subtype.
 *  - **The rate-limit event alone lies.** It is emitted per API attempt and
 *    describes the account, not this pass: a pass can observe a rejection, have
 *    the CLI retry past it, and still finish its work. So a `quota` refusal
 *    takes **both** signals — the exit says the API refused the turn *and* the
 *    account's last word was `rejected`. A pass that merely errored is
 *    `refused { other }`, and a rejection observed by a pass that finished is
 *    left to the quota tile, which is what it is for.
 *
 * The turn ceiling is judged first, ahead of the wall, because that is the
 * order the turn manager has always judged them in (exhaustion before the
 * pause) and an outcome that reordered them would change what a pass at both
 * bounds at once does to its attempt.
 *
 * "The exit says the API refused the turn" is **one** predicate, and it is the
 * one `detectQuotaRejection` used: `is_error` beside a 429 *or* an `api_error`
 * reason (either is enough, so a CLI that stops echoing the status or renames
 * the reason does not take the fleet back to spending attempts on walls). The
 * refusal's kind is then read off the fields that remain — the account's word
 * for the quota, the status for the credential — rather than by a second
 * predicate that could disagree with the first.
 *
 * This leaf also owns `readFinalMessage`, the one rule for what a turn's final
 * message is, because two readers used to read two things: the exit readers
 * took the result event's own `result` string off the raw stream, and the
 * blocked-marker detector took the last assistant text block off the parser.
 * They are byte-identical on every captured stream (pinned by
 * `claude-code-outcome.test.ts`), so the unified rule changes nothing observed
 * — and it is written here, a leaf, so the stream parser and the test bridge
 * (`src/test/claude-stream-fixture.ts`) read the same rule rather than two.
 *
 * Pure and total by construction — every field is read defensively, nothing
 * reads a clock, and an unreadable event yields `failed` rather than throwing:
 * this sits on the completion path of every pass the fleet runs.
 */

import type { QuotaObservation } from "../../quota/rate-limit-event";
import type { TurnOutcome, TurnRefusal } from "../turn-result";

/** The quota status that means "this request was refused", as the CLI sends
 * it. Compared as a string for the reason `rate-limit-event.ts` gives for
 * holding every enum verbatim: a later CLI's new member must not throw. */
const REJECTED_STATUS = "rejected";

/** HTTP status a refused Anthropic request carries, echoed onto the terminal
 * `result` event as `api_error_status`. */
const RATE_LIMIT_HTTP_STATUS = 429;

/** HTTP statuses that say the credential, not the quota, was refused. */
const AUTH_HTTP_STATUSES: readonly number[] = [401, 403];

/** The terminal event's own name for "I stopped because the API said no". */
const API_ERROR_REASON = "api_error";

/** The subtype the CLI reports when it stopped the turn at `--max-turns`. */
const MAX_TURNS_SUBTYPE = "error_max_turns";

/** The subtype of a turn the CLI considers finished — walled or not. */
const SUCCESS_SUBTYPE = "success";

/**
 * Whether the pass's exit condition says the API refused it — the predicate
 * the quota pause has read since issue #168, unchanged (see the module note).
 */
function exitedOnApiError(terminal: Record<string, unknown>): boolean {
  if (terminal.is_error !== true) return false;
  return (
    terminal.api_error_status === RATE_LIMIT_HTTP_STATUS ||
    terminal.terminal_reason === API_ERROR_REASON
  );
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Classify a Claude Code turn's terminal `result` event, with the last quota
 * observation of the turn beside it.
 *
 * Null in, null out: no `result` event at all means the container died
 * mid-turn, which the interruption bound already owns (issue #97) and must
 * keep owning — an infra death is corroborated by nothing here, so it is not
 * dressed up as a `failed` outcome the attempt would be charged for.
 */
export function classifyClaudeExit(
  terminal: Record<string, unknown> | null,
  rateLimit: QuotaObservation | null
): TurnOutcome | null {
  if (terminal === null) return null;

  const subtype = readString(terminal.subtype);

  // The turn ceiling, first — see the module note for why the order matters.
  if (subtype === MAX_TURNS_SUBTYPE) return { kind: "turn-limit" };

  if (exitedOnApiError(terminal)) {
    return { kind: "refused", refusal: classifyRefusal(terminal, rateLimit) };
  }

  if (terminal.is_error === true) {
    return { kind: "failed", reason: subtype ?? readString(terminal.terminal_reason) };
  }

  if (subtype === SUCCESS_SUBTYPE) return { kind: "completed" };

  // A subtype this build has not met (`error_during_execution`, or one a later
  // CLI adds) is a terminal error the harness owned up to. Carried through by
  // name so the feed can say what happened; nothing decides on the word.
  return { kind: "failed", reason: subtype };
}

/**
 * Which refusal an API error was. The caller has already established that the
 * exit says the API refused the turn; what remains is whose word explains it.
 * A quota wall needs the account's own (see the module note); a 401/403 is the
 * credential; anything else the provider said no to is `other`.
 */
function classifyRefusal(
  terminal: Record<string, unknown>,
  rateLimit: QuotaObservation | null
): TurnRefusal {
  if (rateLimit !== null && rateLimit.status === REJECTED_STATUS) {
    return {
      kind: "quota",
      // Verbatim from the event, never computed from a window length: this
      // build does not know how long "five_hour" is for an account on overage,
      // and a resume time the fleet invented would be wrong in the direction
      // that costs a real attempt. Null is a real answer (issue #170): a pause
      // needs a clock, a degrade or a failover does not, and which of the
      // three follows is the reducer's call.
      resumeAfter: rateLimit.resetsAt,
      limitType: rateLimit.rateLimitType,
    };
  }
  const status = terminal.api_error_status;
  if (typeof status === "number" && AUTH_HTTP_STATUSES.includes(status)) {
    return { kind: "auth", resumeAfter: null, limitType: null };
  }
  return { kind: "other", resumeAfter: null, limitType: null };
}

/**
 * The turn's final message: the terminal event's own `result` string when it
 * states a non-empty one, else the last assistant text block the stream
 * carried (`lastText`), else null. See the module note for why this is one
 * rule and where it is read.
 */
export function readFinalMessage(
  terminal: Record<string, unknown> | null,
  lastText: string | null
): string | null {
  const stated = terminal?.result;
  if (typeof stated === "string" && stated.trim() !== "") return stated;
  return lastText;
}
