/**
 * A lane's quota state, as one durable row per lane (issue #167, made per-lane
 * by #175).
 *
 * Latest observation wins, with no history kept: the CLI emits a
 * `rate_limit_event` per API attempt, so a table of them would grow with the
 * fleet's traffic to answer a question — "where is this lane's quota now?" —
 * that only ever needs the last row. When a later ticket wants the shape of a
 * window over time, the passive recorder (`orchestrator/stream-recorder.ts`)
 * already has every event verbatim on disk to build it from.
 *
 * **Per lane, and never fleet-wide.** A rate limit is a fact about one account
 * at one provider. The unified-window machinery is subscription-only (#165's
 * finding 6, re-confirmed against OpenRouter on 2026-09-02 — no unified
 * rate-limit response header, no `rate_limit_event` anywhere on the
 * stream), so a metered lane never produces an observation at all. Keyed by
 * lane, that reads as null, which is the truth: nothing to gate on, and the
 * lane is bounded by spend instead. Keyed by the fleet, the subscription's last
 * reading would stand in for it — and a lane that cannot report a wall would be
 * held behind somebody else's.
 *
 * **The row is stored in the wire's own encoding**, so there is exactly one
 * reader of a quota observation in the codebase: writing projects the
 * observation back to the field names and unix-second timestamps the CLI sent,
 * and reading hands that object to `parseRateLimitEvent`. A stored row this
 * build cannot read therefore fails in precisely the way an unreadable event
 * does — as null, never as a throw — without a second defensive reader to keep
 * in step with the first.
 *
 * Writes swallow their own errors, for the passive recorder's reason: this sits
 * on the stream-parse path of every turn the fleet runs, and telemetry that can
 * fail the pass it describes is worse than no telemetry.
 */

import { db } from "@/db";
import { quotaState } from "@/db/schema";
import { eq } from "drizzle-orm";
import { parseRateLimitEvent, type QuotaObservation } from "./rate-limit-event";

/** Back to the wire's encoding: the CLI sends reset times as unix seconds, and
 * a row that speaks JSON's own date dialect instead would need its own reader. */
function epochSeconds(at: Date | null): number | null {
  return at === null ? null : Math.floor(at.getTime() / 1000);
}

/** The `rate_limit_info` this observation would have arrived as. */
function toStoredInfo(observation: QuotaObservation): Record<string, unknown> {
  return {
    status: observation.status,
    rateLimitType: observation.rateLimitType,
    utilization: observation.utilization,
    resetsAt: epochSeconds(observation.resetsAt),
    overageStatus: observation.overageStatus,
    overageResetsAt: epochSeconds(observation.overageResetsAt),
    isUsingOverage: observation.isUsingOverage,
    overageInUse: observation.overageInUse,
  };
}

/**
 * Record an observation as the current quota state **of the lane it was seen
 * on**. Upserts that lane's row, so the first observation on a long-lived
 * install creates it.
 */
export function recordQuotaObservation(
  lane: string,
  observation: QuotaObservation
): void {
  try {
    const info = toStoredInfo(observation);
    db.insert(quotaState)
      .values({
        lane,
        observation: info,
        observedAt: observation.observedAt,
      })
      .onConflictDoUpdate({
        target: quotaState.lane,
        set: { observation: info, observedAt: observation.observedAt },
      })
      .run();
  } catch (err) {
    console.error("[quota] failed to record observation:", err);
  }
}

/**
 * A lane's last observed quota state, or null when no pass on that lane has
 * reported one.
 *
 * Null is a real answer the tile renders, not a failure, and it has three
 * causes worth keeping apart in the reader's head: a fresh install; a lane
 * whose id no longer names anything (renamed in a deploy); and — permanently —
 * any metered lane, which the provider gives no quota telemetry for. A row
 * written by a since-changed build reads as null too, rather than breaking the
 * dashboard.
 *
 * `lane` may be null (nothing resolved as primary), which is null in, null out:
 * there is no lane to have a quota.
 */
export function getQuotaObservation(
  lane: string | null
): QuotaObservation | null {
  if (lane === null) return null;
  try {
    const row = db
      .select()
      .from(quotaState)
      .where(eq(quotaState.lane, lane))
      .get();
    if (!row) return null;

    return parseRateLimitEvent(
      { type: "rate_limit_event", rate_limit_info: row.observation },
      row.observedAt
    );
  } catch (err) {
    console.error("[quota] failed to read observation:", err);
    return null;
  }
}

/**
 * Every lane's last observation, keyed by lane id — what cost routing reads
 * (issue #176), because "which lanes can serve a request right now?" is a
 * question about all of them at once and asking it lane by lane would make
 * each caller decide which lanes to ask about.
 *
 * A lane with no row is **absent from the map**, which reads as null at every
 * caller and is the truth: it has reported nothing, which is the permanent
 * state of a metered lane and must never read as a closed door (#171's rule).
 * One query rather than one per lane, and a row this build cannot parse is
 * dropped exactly as the single-lane read drops it.
 */
export function getQuotaObservations(): Record<string, QuotaObservation> {
  const observations: Record<string, QuotaObservation> = {};
  try {
    for (const row of db.select().from(quotaState).all()) {
      const parsed = parseRateLimitEvent(
        { type: "rate_limit_event", rate_limit_info: row.observation },
        row.observedAt
      );
      if (parsed !== null) observations[row.lane] = parsed;
    }
  } catch (err) {
    console.error("[quota] failed to read observations:", err);
  }
  return observations;
}
