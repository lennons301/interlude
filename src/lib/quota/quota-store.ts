/**
 * The fleet's quota state, as one durable row (issue #167).
 *
 * Latest observation wins, with no history kept: the CLI emits a
 * `rate_limit_event` per API attempt, so a table of them would grow with the
 * fleet's traffic to answer a question — "where is the quota now?" — that only
 * ever needs the last row. When a later ticket wants the shape of a window over
 * time, the passive recorder (`orchestrator/stream-recorder.ts`) already has
 * every event verbatim on disk to build it from.
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
import { QUOTA_STATE_ROW_ID, quotaState } from "@/db/schema";
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
 * Record an observation as the fleet's current quota state. Upserts the single
 * row, so the first observation on a long-lived install creates it.
 */
export function recordQuotaObservation(observation: QuotaObservation): void {
  try {
    const info = toStoredInfo(observation);
    db.insert(quotaState)
      .values({
        id: QUOTA_STATE_ROW_ID,
        observation: info,
        observedAt: observation.observedAt,
      })
      .onConflictDoUpdate({
        target: quotaState.id,
        set: { observation: info, observedAt: observation.observedAt },
      })
      .run();
  } catch (err) {
    console.error("[quota] failed to record observation:", err);
  }
}

/**
 * The fleet's last observed quota state, or null when no pass has reported one.
 *
 * Null is a real answer the tile renders, not a failure: a fresh install has
 * never seen an event, and neither has one whose passes all authenticate with
 * an API key — the unified-window machinery is subscription-only (#165's
 * finding 6), so a metered lane reports no quota at all. A row written by a
 * since-changed build reads as null too, rather than breaking the dashboard.
 */
export function getQuotaObservation(): QuotaObservation | null {
  try {
    const row = db
      .select()
      .from(quotaState)
      .where(eq(quotaState.id, QUOTA_STATE_ROW_ID))
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
