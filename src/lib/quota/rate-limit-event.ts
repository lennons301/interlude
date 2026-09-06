/**
 * The `rate_limit_event` a harness with quota telemetry puts on its stream,
 * read into one observation of a lane's quota (issue #167). The shape is the
 * first adapter's wire format, held verbatim (see below); an adapter that
 * emits it is what a `quotaTelemetry` capability declares (issue #219).
 *
 * The event is derived from the provider's unified rate-limit response
 * headers, and the spike on #165 established three things this module is
 * shaped by:
 *
 *  - It **does** reach stdout under `--output-format stream-json --verbose`,
 *    as the second event of the stream, so no coarser fallback signal is
 *    needed. The captured proof is `rate-limit-allowed-fixture.ndjson`.
 *  - The wire carries **more fields than the CLI's own schema documents**
 *    (`isUsingOverage`, `overageInUse`), and **fewer than it promises**:
 *    `utilization` and `resetsAt` are each absent from some real events, not
 *    null. So every field here is optional, and absent is kept distinct from
 *    zero — a gate that read a missing utilization as 0% would read a walled
 *    account as an idle one.
 *  - It repeats within a turn, once per API attempt. Latest wins.
 *
 * Nothing here decides anything: this ticket makes the fleet able to *see* its
 * quota. Pausing (#168) and admission (#171) are the tickets that act.
 *
 * **Enums are held verbatim, deliberately.** `status` and `rateLimitType` are
 * strings, not unions, because a future CLI adding a member to either must not
 * throw and must not be silently dropped — the value the fleet could not
 * interpret is exactly the one an operator needs to see on the screen. The
 * known members are listed here only so a caller can decide how to *paint* one;
 * see {@link quotaSeverity} and {@link describeRateLimitType}, both of which
 * have an answer for a member they have never heard of.
 */

/** Statuses this build understands. Not a parse-time constraint — see above. */
export const QUOTA_STATUSES = [
  "allowed",
  "allowed_warning",
  "rejected",
] as const;

export type QuotaStatus = (typeof QUOTA_STATUSES)[number];

/** Limit windows this build understands, in the CLI's own vocabulary. */
export const RATE_LIMIT_TYPES = [
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_overage_included",
  "overage",
] as const;

export type RateLimitType = (typeof RATE_LIMIT_TYPES)[number];

/**
 * One observation of the account's quota, as a single pass saw it.
 *
 * There is exactly one limit type on an event because the server has already
 * chosen it: the `unified-representative-claim` header names the window
 * *closest to tripping*, which is why the tile can show "which limit is closest"
 * without computing anything.
 */
export interface QuotaObservation {
  /** Verbatim: `allowed` | `allowed_warning` | `rejected`, or whatever a later
   * CLI starts sending. */
  status: string;
  /** The representative claim — the window closest to tripping. Verbatim, and
   * null when the event carried none. */
  rateLimitType: string | null;
  /** Percentage 0–100 of that window consumed, or null when the event carried
   * none. Absent is common: the field only appears when a claim-scoped
   * utilization header is set, so null means "not reported", never "0%". */
  utilization: number | null;
  /** When the representative window resets, or null when unreported. Present
   * on a rejection (which is what a pause would resume from) but absent from
   * some `allowed_warning` events, so the tile must render a reset-less
   * warning. */
  resetsAt: Date | null;
  /** The overage window's own status, verbatim, or null. */
  overageStatus: string | null;
  overageResetsAt: Date | null;
  /** Undocumented on the CLI's schema, present on the wire: whether this
   * request drew on overage, and whether overage billing is available at all.
   * Unused by the tile — kept because #173 decides "already spending real
   * money" from them and a record written without them could not be revisited. */
  isUsingOverage: boolean | null;
  overageInUse: boolean | null;
  /** When the orchestrator saw the event. The fleet's own clock, not the
   * event's — the event carries no timestamp. */
  observedAt: Date;
}

/** How urgently a status reads. `unknown` is a real state, not an error: a
 * status this build has never seen is shown as itself, in a neutral tone,
 * rather than being guessed at or dropped. */
export type QuotaSeverity = "ok" | "warning" | "blocked" | "unknown";

const SEVERITY: Record<QuotaStatus, QuotaSeverity> = {
  allowed: "ok",
  allowed_warning: "warning",
  rejected: "blocked",
};

export function quotaSeverity(status: string): QuotaSeverity {
  return SEVERITY[status as QuotaStatus] ?? "unknown";
}

/** Plain-English name for a limit window, or the raw value for one this build
 * does not know. */
const LIMIT_LABELS: Record<RateLimitType, string> = {
  five_hour: "5-hour window",
  seven_day: "weekly",
  seven_day_opus: "weekly opus",
  seven_day_sonnet: "weekly sonnet",
  seven_day_overage_included: "weekly incl. overage",
  overage: "overage",
};

export function describeRateLimitType(rateLimitType: string): string {
  return LIMIT_LABELS[rateLimitType as RateLimitType] ?? rateLimitType;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Unix seconds -> Date. Zero and negatives are treated as unreported: they are
 * what an unset header decodes to, and 1970 on a reset line is worse than
 * nothing. */
function readEpochSeconds(value: unknown): Date | null {
  const seconds = readNumber(value);
  return seconds !== null && seconds > 0 ? new Date(seconds * 1000) : null;
}

/**
 * Read a stream event into an observation, or null when it is not a usable
 * `rate_limit_event`.
 *
 * Total by construction — every field is read defensively and an unreadable
 * one becomes null, because this runs on the stream-parse path of every turn
 * the fleet runs and a throw here would fail a pass over a log line.
 *
 * The fields are read from the event's `rate_limit_info` object, which is where
 * the captured stream carries them, falling back to the event itself so that a
 * CLI which flattens the shape #167 documents still parses. `status` is the one
 * required field: without it there is nothing to say, so the observation is
 * refused rather than stored blank.
 */
export function parseRateLimitEvent(
  event: unknown,
  observedAt: Date
): QuotaObservation | null {
  if (!isRecord(event) || event.type !== "rate_limit_event") return null;

  const info = isRecord(event.rate_limit_info) ? event.rate_limit_info : event;
  const status = readString(info.status);
  if (status === null) return null;

  return {
    status,
    rateLimitType: readString(info.rateLimitType),
    utilization: readNumber(info.utilization),
    resetsAt: readEpochSeconds(info.resetsAt),
    overageStatus: readString(info.overageStatus),
    overageResetsAt: readEpochSeconds(info.overageResetsAt),
    isUsingOverage: readBoolean(info.isUsingOverage),
    overageInUse: readBoolean(info.overageInUse),
    observedAt,
  };
}
