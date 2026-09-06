/**
 * Stored lane pins for tickets the loop has not claimed yet (issue #241).
 *
 * A run row does not exist until the sweep claims the ticket, so an operator
 * who wants one ticket on one lane has nowhere to say so until then. This
 * table is that somewhere: one row per (project, issue), written by the
 * operator API and read exactly once, by `executeClaim`, which copies the lane
 * onto `runs.lanePin` and deletes the row. Spent-once is deliberate: a pin is
 * a decision about the attempt the operator was looking at, and a later
 * attempt after `ready-for-human` should route as the fleet does unless the
 * operator pins it again.
 *
 * Never fed from an issue body. The directive parser has no lane key (#197,
 * #213): a semi-trusted ticket may say how hard its work is, never who pays.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { lanePins, type LanePin } from "@/db/schema";
import { newId } from "../ulid";

export function readLanePin(projectId: string, issueNumber: number): LanePin | null {
  return (
    db
      .select()
      .from(lanePins)
      .where(and(eq(lanePins.projectId, projectId), eq(lanePins.issueNumber, issueNumber)))
      .get() ?? null
  );
}

/** Set (or replace) the pin for a ticket. One row per ticket, by construction. */
export function setLanePin(projectId: string, issueNumber: number, lane: string, now = new Date()): LanePin {
  clearLanePin(projectId, issueNumber);
  const row: LanePin = { id: newId(), projectId, issueNumber, lane, createdAt: now };
  db.insert(lanePins).values(row).run();
  return row;
}

/** Remove a ticket's pin; true when one was there. */
export function clearLanePin(projectId: string, issueNumber: number): boolean {
  const existing = readLanePin(projectId, issueNumber);
  if (existing === null) return false;
  db.delete(lanePins).where(eq(lanePins.id, existing.id)).run();
  return true;
}

/** Read and consume a ticket's pin — what the claim does. */
export function takeLanePin(projectId: string, issueNumber: number): string | null {
  const existing = readLanePin(projectId, issueNumber);
  if (existing === null) return null;
  db.delete(lanePins).where(eq(lanePins.id, existing.id)).run();
  return existing.lane;
}
