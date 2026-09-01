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
 * Writes swallow their own errors, for the recorder's reason: this sits on the
 * stream-parse path of every turn the fleet runs, and telemetry that can fail
 * the pass it describes is worse than no telemetry. Reads are defensive for
 * `settings.overrides`' reason: the JSON was written by some build of this app,
 * not necessarily this one.
 */

import { db } from "@/db";
import { QUOTA_STATE_ROW_ID, quotaState } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { QuotaObservation } from "./rate-limit-event";

/** The stored shape: the observation with its Dates as ISO text, because JSON
 * has no date and a column that round-trips differently than it was written is
 * a bug waiting for a reader. */
interface StoredObservation {
  status: string;
  rateLimitType: string | null;
  utilization: number | null;
  resetsAt: string | null;
  overageStatus: string | null;
  overageResetsAt: string | null;
  isUsingOverage: boolean | null;
  overageInUse: boolean | null;
}

function toStored(observation: QuotaObservation): StoredObservation {
  return {
    status: observation.status,
    rateLimitType: observation.rateLimitType,
    utilization: observation.utilization,
    resetsAt: observation.resetsAt?.toISOString() ?? null,
    overageStatus: observation.overageStatus,
    overageResetsAt: observation.overageResetsAt?.toISOString() ?? null,
    isUsingOverage: observation.isUsingOverage,
    overageInUse: observation.overageInUse,
  };
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

function readDate(value: unknown): Date | null {
  const iso = readString(value);
  if (iso === null) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * Record an observation as the fleet's current quota state. Upserts the single
 * row, so the first observation on a long-lived install creates it.
 */
export function recordQuotaObservation(observation: QuotaObservation): void {
  try {
    const values = {
      id: QUOTA_STATE_ROW_ID,
      observation: toStored(observation),
      observedAt: observation.observedAt,
    };
    db.insert(quotaState)
      .values(values)
      .onConflictDoUpdate({
        target: quotaState.id,
        set: { observation: values.observation, observedAt: values.observedAt },
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
 * never seen an event, and so does one whose passes all authenticate with an
 * API key — the unified-window machinery is subscription-only (#165's finding
 * 6), so a metered lane reports no quota at all.
 *
 * Anything unreadable in the row also reads as null rather than throwing, so a
 * column written by a since-changed build cannot break the dashboard.
 */
export function getQuotaObservation(): QuotaObservation | null {
  try {
    const row = db
      .select()
      .from(quotaState)
      .where(eq(quotaState.id, QUOTA_STATE_ROW_ID))
      .get();
    if (!row) return null;

    const stored = row.observation as Partial<StoredObservation> | null;
    if (typeof stored !== "object" || stored === null) return null;
    const status = readString(stored.status);
    if (status === null) return null;

    return {
      status,
      rateLimitType: readString(stored.rateLimitType),
      utilization: readNumber(stored.utilization),
      resetsAt: readDate(stored.resetsAt),
      overageStatus: readString(stored.overageStatus),
      overageResetsAt: readDate(stored.overageResetsAt),
      isUsingOverage: readBoolean(stored.isUsingOverage),
      overageInUse: readBoolean(stored.overageInUse),
      observedAt: row.observedAt,
    };
  } catch (err) {
    console.error("[quota] failed to read observation:", err);
    return null;
  }
}
