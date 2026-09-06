/**
 * How a Codex turn ended, in the fleet's vocabulary (issue #221).
 *
 * Codex's `--json` stream ends a turn with exactly one of two events:
 * `turn.completed`, carrying the turn's token usage, or `turn.failed`,
 * carrying one string, `error.message`. There is no exit subtype, no HTTP
 * status field and no quota telemetry event — the exec stream's schema has no
 * rate-limit member at all, which is why the adapter declares no
 * `quotaTelemetry` — so the CLI's own sentence is the whole signal, and this
 * leaf is the one place it is read. Nothing outside `src/lib/harness/codex/`
 * sees the sentence; the rest of the fleet branches on what this returns.
 *
 * Four shapes were recorded against the real CLI (0.153.4; the fixtures sit
 * beside the tests — the first three recorded through
 * `scripts/codex-responses-stub.mjs`, the fourth against the real API):
 *
 *  - A 429 from an API-key provider, after the CLI's own retries:
 *    `exceeded retry limit, last status: 429 Too Many Requests`.
 *  - A ChatGPT-plan usage wall (`usage_limit_reached`), which the CLI phrases
 *    itself: `You've hit your usage limit. … or try again at 9:16 PM.` — the
 *    reset stated as a clock time in the process's local zone, with no date.
 *  - A rejected credential: `unexpected status 401 Unauthorized: Incorrect API
 *    key provided: …, auth error code: invalid_api_key`.
 *  - An organisation with no prepaid credits (recorded on the proof ticket,
 *    #224, against the real API): `stream disconnected before completion: You
 *    have no credits remaining. Add credits to continue using the API at …`.
 *    On the wire that is a 429 with `type: insufficient_quota` and `code:
 *    credit_balance_exhausted`, but the CLI's sentence carries neither the
 *    status nor the code — only the words — after retrying over WebSockets,
 *    falling back to HTTPS and retrying again (nine reconnects narrated as
 *    `error` events, ~26 s in all). It is a
 *    quota refusal for the same reason OpenRouter's 402 is one on the OpenCode
 *    adapter: the lane cannot serve the request until money is added, so the
 *    fleet fails over or parks rather than spending an attempt on it.
 *
 * The classifier reads the *kind* of refusal off those words — quota first,
 * because a quota sentence also carries a status word; then a credential
 * refusal; then any other HTTP status the provider answered with. A
 * `turn.failed` naming no provider refusal is the harness's own `failed` (a
 * lost stream, a sandbox error, a session it could not find), carried through
 * by its message so the feed can say what happened; nothing decides on the
 * word. Codex has no turn ceiling — there is no `--max-turns` — so nothing here
 * yields `turn-limit`; the ceiling on a Codex pass is the orchestrator's
 * per-exec wall clock (issue #220), which forces `turn-limit` itself.
 *
 * The reset time is the one inference made here. The wall sentence states a
 * wall-clock time and no date, formatted in the CLI's local zone. The fleet
 * reads it as the next occurrence of that time in *its own* local zone — right
 * whenever the agent container and the orchestrator share a zone, which they
 * do on the VPS (both containers run UTC) but not in local development, where
 * the orchestrator runs on the host in the host's zone and the agent container
 * in the image's (UTC: a BST host reads the wall an hour off) — so on the VPS
 * a wall becomes a pause rather than a spent attempt. A wrong zone costs no
 * attempt in either direction: too early, the resumed pass meets the wall again
 * and pauses again (bounded by the resume count); too late, it waits out the
 * offset. A sentence stating no time yields null, which the reducer already
 * handles (#170: a degrade or a failover needs no clock; a pause without one
 * parks on #220's default backoff rather than spending the attempt).
 *
 * Pure and total by construction — every field is read defensively, the clock
 * is a parameter, and an unreadable event yields `failed` rather than throwing:
 * this sits on the completion path of every pass a Codex lane runs.
 */

import type { TurnOutcome, TurnRefusal } from "../turn-result";

/** The two events that end a Codex turn, by their wire names. */
export const CODEX_TURN_COMPLETED = "turn.completed";
export const CODEX_TURN_FAILED = "turn.failed";

/**
 * The account's allowance is spent — in the CLI's own words for a ChatGPT-plan
 * wall ("usage limit"), in HTTP's for an API-key one ("429", "Too Many
 * Requests"), in the provider's for an organisation out of prepaid credits
 * ("no credits remaining", the one sentence the CLI relays for a
 * `credit_balance_exhausted` 429 — see the module note), and in the API's
 * error codes when the CLI echoes a body.
 */
const QUOTA_WORDS =
  /usage limit|rate limit|too many requests|\b429\b|usage_limit_reached|rate_limit_exceeded|insufficient_quota|credit_balance_exhausted|no credits remaining|insufficient credits|\bquota\b/i;

/** The credential was refused: the status, or the API's own words for it. */
const AUTH_WORDS =
  /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid_api_key|incorrect api key|auth error/i;

/** The provider answered with some other status — an overload, a 5xx. */
const PROVIDER_STATUS_WORDS =
  /(unexpected status|last status:)\s*\d{3}|server overloaded|service unavailable|bad gateway|gateway timeout/i;

/** The clock time a ChatGPT-plan wall names: `try again at 9:16 PM`. */
const TRY_AGAIN_AT = /try again at (\d{1,2}):(\d{2})\s*([AP]M)\b/i;

/** How much of a failure sentence rides on the outcome as its reason. */
const MAX_REASON_CHARS = 200;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The one string a `turn.failed` event carries, or null when it carries none. */
export function readFailureMessage(terminal: Record<string, unknown>): string | null {
  if (isRecord(terminal.error)) return readNonEmptyString(terminal.error.message);
  return readNonEmptyString(terminal.message);
}

/**
 * Classify a Codex turn's terminal event (`turn.completed` or `turn.failed`).
 *
 * Null in, null out: no terminal event at all means the process died mid-turn
 * (or never found its session), which the interruption bound owns (issue #97)
 * and must keep owning — an infra death is corroborated by nothing here, so it
 * is not dressed up as a `failed` outcome the attempt would be charged for.
 */
export function classifyCodexExit(
  terminal: Record<string, unknown> | null,
  now: Date
): TurnOutcome | null {
  if (terminal === null) return null;
  const type = readNonEmptyString(terminal.type);

  if (type === CODEX_TURN_COMPLETED) return { kind: "completed" };

  if (type === CODEX_TURN_FAILED) {
    const message = readFailureMessage(terminal);
    const refusal = readCodexRefusal(message, now);
    if (refusal !== null) return { kind: "refused", refusal };
    return { kind: "failed", reason: message === null ? null : message.slice(0, MAX_REASON_CHARS) };
  }

  // Not a turn-ending event this build knows. Carried through by name so the
  // feed can say what happened; nothing decides on the word.
  return { kind: "failed", reason: type };
}

/**
 * Which provider refusal, if any, a `turn.failed` sentence describes — see the
 * module note for the four recorded shapes and the order of the readings.
 */
export function readCodexRefusal(message: string | null, now: Date): TurnRefusal | null {
  if (message === null) return null;
  if (QUOTA_WORDS.test(message)) {
    return {
      kind: "quota",
      resumeAfter: parseTryAgainAt(message, now),
      // The sentence names no window the tier ladder could read (#170): a
      // ChatGPT wall is account-wide by construction, and an API 429 names a
      // model, not a tier. Null, as the ladder's cautious answer.
      limitType: null,
    };
  }
  if (AUTH_WORDS.test(message)) return { kind: "auth", resumeAfter: null, limitType: null };
  if (PROVIDER_STATUS_WORDS.test(message)) {
    return { kind: "other", resumeAfter: null, limitType: null };
  }
  return null;
}

/**
 * The next occurrence, in this process's local zone, of the clock time a wall
 * sentence names — or null when it names none (see the module note for why
 * the zone is assumed shared, and what a wrong assumption costs).
 */
export function parseTryAgainAt(message: string, now: Date): Date | null {
  const match = TRY_AGAIN_AT.exec(message);
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const hours = (hour % 12) + (match[3].toUpperCase() === "PM" ? 12 : 0);
  const at = new Date(now.getTime());
  at.setHours(hours, minute, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at;
}
