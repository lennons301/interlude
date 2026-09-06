/**
 * How an OpenCode turn ended, in the fleet's vocabulary (issue #222).
 *
 * `opencode run --format json` has **no terminal event of its own**. The
 * stream is one JSON object per line — `step_start`, `tool_use`, `text`,
 * `step_finish`, `reasoning`, and `error` when a provider or the CLI refuses
 * — and then the process exits: 0 on a clean finish, 1 after an `error`
 * (measured on 1.18.29; the fixtures beside the tests are the recordings). So
 * the adapter's turn script emits a terminal event itself, **after** the CLI
 * has exited and the session database has been checkpointed:
 * `{"type": "interlude.turn_exit", "exitCode": N}`. It is the adapter's own
 * word, not the harness's, and it is what makes a null outcome mean what it
 * means everywhere else: the wrapper never got to say — the container died,
 * or the wall-clock stop (#220) killed the turn's whole process tree, script
 * included — which the interruption bound and the ceiling own upstream.
 *
 * A refusal arrives as one `error` event whose `error.name` is `APIError` and
 * whose `error.data` carries the provider's HTTP `statusCode`, its `message`
 * and the `responseBody` verbatim. The status is the whole signal, and this
 * leaf is the one place it is read:
 *
 *  - **429 and 402 are quota.** A rate limit, and OpenRouter's "insufficient
 *    credits" — both say the account's allowance is spent, which is the wall
 *    the reducer's ordering (degrade, fail over, park) exists for; a refusal
 *    that spent an attempt instead would route a good ticket to a human
 *    because the account ran dry. Recorded: the CLI retried a 429 nine times
 *    over ~80s before surfacing it, so a surfaced 429 is a standing wall, not
 *    a blip. Neither names a reset the fleet can read off the harness's own
 *    fields — a `Retry-After` may sit inside the provider's body, but that is
 *    the provider's shape, not the CLI's — so `resumeAfter` is null and a
 *    pause parks on #220's default backoff; a failover needs no clock.
 *  - **401 and 403 are the credential** (`auth`): a lane-availability failure,
 *    never a wall (#220). Recorded: an invalid OpenRouter key is a 401 "User
 *    not found."
 *  - **Any other status is `other`** — a 5xx, or OpenRouter's 404 "No endpoints
 *    found that support tool use" for a model that cannot run the harness.
 *    The ordinary path; nothing branches on it.
 *  - An `error` carrying **no status** is the CLI's own (`MessageOutputLength
 *    Error`, `ContextOverflowError`, an aborted message): `failed`, named by
 *    the error's name so the feed can say what happened.
 *  - No `error` and exit 0 is `completed`; no `error` and a non-zero exit is
 *    `failed` naming the code.
 *
 * `limitType` is always null: nothing on this wire names a window, let alone a
 * tier-scoped one, so the ladder (#170) never steps a run off an OpenCode
 * refusal — the fail-over-or-park half of the ordering is what applies.
 * OpenCode has no turn ceiling (no `--max-turns`), so nothing here yields
 * `turn-limit`; the ceiling on an OpenCode pass is the orchestrator's per-exec
 * wall clock (#220), which forces `turn-limit` itself.
 *
 * Pure and total by construction — every field is read defensively and an
 * unreadable event yields `failed` rather than throwing: this sits on the
 * completion path of every pass an OpenCode lane runs.
 */

import type { TurnOutcome, TurnRefusal } from "../turn-result";

/** The terminal event the adapter's turn script emits once the CLI has exited
 * and the database has been checkpointed — see the module note. Namespaced so
 * no event the CLI itself emits can ever be mistaken for it. */
export const OPENCODE_TURN_EXIT_EVENT = "interlude.turn_exit";

/** The CLI's own event for a provider or harness error. */
export const OPENCODE_ERROR_EVENT = "error";

/** HTTP statuses that say the account's allowance is spent. */
const QUOTA_HTTP_STATUSES: readonly number[] = [429, 402];

/** HTTP statuses that say the credential, not the quota, was refused. */
const AUTH_HTTP_STATUSES: readonly number[] = [401, 403];

/** How much of an error's sentence rides on a `failed` outcome as its reason. */
const MAX_REASON_CHARS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** What an `error` event says, in the three fields this leaf reads. */
export interface OpenCodeError {
  /** The error's own name (`APIError`, `MessageOutputLengthError`, …). */
  name: string | null;
  /** The provider's or the CLI's sentence. */
  message: string | null;
  /** The provider's HTTP status, or null when the error carries none. */
  statusCode: number | null;
}

/**
 * Read an `error` event (`{ type: "error", error: { name, data: { message,
 * statusCode, … } } }`) into the fields the classifier reads. Null for an event
 * carrying no `error` object at all.
 */
export function readOpenCodeError(event: Record<string, unknown>): OpenCodeError | null {
  const error = event.error;
  if (!isRecord(error)) return null;
  const data = isRecord(error.data) ? error.data : {};
  const status = data.statusCode;
  return {
    name: readNonEmptyString(error.name),
    // The data's own sentence first; the wrapper's `message`, when the CLI
    // set one, says the same thing with the name in front.
    message: readNonEmptyString(data.message) ?? readNonEmptyString(error.message),
    statusCode: typeof status === "number" && Number.isFinite(status) ? status : null,
  };
}

/** The exit code the terminal event carries, or null when it carries none a
 * process could have produced. */
export function readExitCode(terminal: Record<string, unknown>): number | null {
  const code = terminal.exitCode;
  return typeof code === "number" && Number.isInteger(code) && code >= 0 ? code : null;
}

/**
 * Classify an OpenCode turn from the adapter's terminal event and the last
 * `error` event the stream carried.
 *
 * Null in, null out: no terminal event means the turn script never reached its
 * last line — the container died, or the wall-clock stop killed the tree —
 * which the interruption bound (#97) and the ceiling (#220) own upstream, and
 * must keep owning: an infra death is corroborated by nothing here, so it is
 * not dressed up as a `failed` outcome the attempt would be charged for.
 */
export function classifyOpenCodeExit(
  terminal: Record<string, unknown> | null,
  lastError: OpenCodeError | null
): TurnOutcome | null {
  if (terminal === null) return null;

  // The error outranks the exit code: the CLI exits 1 after one, and a
  // refusal read off the code alone would be a `failed` that spent an attempt
  // on a wall.
  if (lastError !== null) {
    const refusal = classifyRefusal(lastError);
    if (refusal !== null) return { kind: "refused", refusal };
    const reason = lastError.name ?? lastError.message?.slice(0, MAX_REASON_CHARS) ?? null;
    return { kind: "failed", reason };
  }

  const exitCode = readExitCode(terminal);
  if (exitCode === 0) return { kind: "completed" };
  return { kind: "failed", reason: exitCode === null ? "no exit code" : `exit ${exitCode}` };
}

/**
 * Which provider refusal, if any, an `error` describes — by its HTTP status
 * (see the module note for each). An error carrying no status is the CLI's
 * own, not a refusal.
 */
export function classifyRefusal(error: OpenCodeError): TurnRefusal | null {
  const status = error.statusCode;
  if (status === null) return null;
  if (QUOTA_HTTP_STATUSES.includes(status)) {
    return { kind: "quota", resumeAfter: null, limitType: null };
  }
  if (AUTH_HTTP_STATUSES.includes(status)) {
    return { kind: "auth", resumeAfter: null, limitType: null };
  }
  return { kind: "other", resumeAfter: null, limitType: null };
}
