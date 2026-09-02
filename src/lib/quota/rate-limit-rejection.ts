/**
 * Was this pass *refused* by the account's quota, and when may it be tried
 * again? (issue #168)
 *
 * #167 made the fleet able to see its quota; this is the first thing that
 * decides on what it saw. The decision is small and lives in one pure function
 * because it is the whole difference between a ticket that gets three real
 * attempts and one routed to a human because the account ran out of window.
 *
 * Two signals, and it takes **both**, because each alone lies in a way the
 * spike on #165 measured:
 *
 *  - The **exit condition** says the pass ended on an API error, but not which
 *    one, and — the finding that most changes this ticket's premise — a quota
 *    rejection reports `subtype: "success"`. Only `is_error`,
 *    `terminal_reason` and `api_error_status` separate it from a clean finish,
 *    which is why `TurnResult` carries the terminal event whole.
 *  - The **rate-limit event** says the account was rejected and when its
 *    window resets, but it is emitted per API attempt and describes the
 *    account, not this pass: a pass can observe a rejection, have the CLI
 *    retry past it, and still finish its work. Pausing that run would park a
 *    finished attempt on a clock.
 *
 * So: refused *and* said to be refused. A pass that merely errored is left to
 * the ordinary failure paths, and a rejection observed by a pass that finished
 * is left to the quota tile, which is what it is for.
 *
 * Pure and total by construction — every field is read defensively, nothing
 * reads a clock, and an unreadable event yields null rather than throwing:
 * this sits on the completion path of every autonomous pass the fleet runs.
 */

import type { QuotaObservation } from "./rate-limit-event";

/** The quota status that means "this request was refused", as the CLI sends
 * it. Compared as a string for the reason `rate-limit-event.ts` gives for
 * holding every enum verbatim: a later CLI's new member must not throw. */
const REJECTED_STATUS = "rejected";

/** HTTP status a refused Anthropic request carries, echoed onto the terminal
 * `result` event as `api_error_status`. */
const RATE_LIMIT_HTTP_STATUS = 429;

/** The terminal event's own name for "I stopped because the API said no". */
const API_ERROR_REASON = "api_error";

/**
 * A pass the account's quota refused, and the clock it is waiting on.
 */
export interface QuotaRejection {
  /**
   * When the window the account was refused on resets — the earliest moment a
   * paused run could be tried again.
   *
   * Taken verbatim from the event rather than computed from a window length,
   * because this build does not know how long "five_hour" is for an account
   * on overage, and a resume time the fleet invented would be wrong in the
   * direction that costs a real attempt.
   */
  resumeAfter: Date;
  /** Which window refused it — `five_hour`, `seven_day`, … — verbatim, or null
   * when the event named none. Said on the issue and the card, never branched
   * on: every unified window is account-wide, and a member this build has
   * never heard of must pause the run exactly as a known one does. */
  limitType: string | null;
}

/** The two fields of a `TurnResult` this reads — narrowed so a caller cannot
 * accidentally pass a stale, re-read turn. */
export interface RateLimitedTurn {
  terminalResult: Record<string, unknown> | null;
  rateLimit: QuotaObservation | null;
}

/**
 * Whether the pass's exit condition says the API refused it.
 *
 * A null terminal result is *not* an API refusal: no `result` event at all
 * means the container died mid-turn, which the interruption bound already owns
 * (issue #97) and which must keep owning it — an infra death is corroborated
 * by nothing here.
 *
 * Either field is enough alongside `is_error`, so that a CLI which stops
 * echoing the HTTP status (or renames the reason) does not silently take the
 * fleet back to burning attempts on quota walls.
 */
function exitedOnApiError(terminal: Record<string, unknown> | null): boolean {
  if (terminal === null) return false;
  if (terminal.is_error !== true) return false;
  return (
    terminal.api_error_status === RATE_LIMIT_HTTP_STATUS ||
    terminal.terminal_reason === API_ERROR_REASON
  );
}

/**
 * The quota wall this turn hit, or null when it hit none.
 *
 * Null covers every ordinary case, including two worth naming: a metered
 * (API-key) lane, where the unified-window machinery emits no event at all so
 * there is never anything to read (#165, finding 6); and a rejection whose
 * event carried no reset time, where there is no clock to wait on — pausing
 * indefinitely on an unknown window would strand the run somewhere no later
 * ticket can find it, so the pass takes its ordinary path and the attempt is
 * spent, exactly as before this ticket.
 */
export function detectQuotaRejection(turn: RateLimitedTurn): QuotaRejection | null {
  const observed = turn.rateLimit;
  if (observed === null || observed.status !== REJECTED_STATUS) return null;
  if (!exitedOnApiError(turn.terminalResult)) return null;
  if (observed.resetsAt === null) return null;

  return { resumeAfter: observed.resetsAt, limitType: observed.rateLimitType };
}
