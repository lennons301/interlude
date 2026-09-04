/**
 * The claim's read of a triage pass's suggested tier (issue #200) — DB-only,
 * like `review-tasks.ts`, so the reader can be pinned against an in-memory
 * database beside the writer it must agree with (`finishTriagePass`).
 */

import { and, desc, eq } from "drizzle-orm";
import { tasks } from "@/db/schema";
import { normalizeModelTier, type ModelTier } from "../../model-tiers";
import type { Db } from "./review-tasks";

/**
 * The tier the issue's most recent *completed* triage pass suggested for its
 * work, or null when it suggested none. Read off `tasks.triageTier`, which
 * outlives the exit's consumption for exactly this read: the claim may come
 * hours after the pass, on a human's label click or Discord "yes". The newest
 * pass that ran to completion decides, a null included — a re-triage that
 * omitted the line means "the default", not "whatever an earlier pass said
 * about an earlier body" — while a pass that died (`failed`, no exit) says
 * nothing and leaves the last judgement standing.
 *
 * The status is a safe key because `finishTriagePass` writes the exit and
 * `completed` in one statement: every pass the sweep's pending-triage gather
 * applied by its stored exit is `completed` from the same instant, and the
 * only `failed` rows holding a result are the ones the turn manager's catch
 * wrote for a pass that died — which the gather applies fail-closed and this
 * read skips, so the embed and the claim always name the same pass. The
 * stored word is re-clamped to the vocabulary on the way in: a row is data,
 * and the reducer only ever sees a tier.
 */
export function latestTriageTier(db: Db, issueRef: string): ModelTier | null {
  const row = db
    .select({ tier: tasks.triageTier })
    .from(tasks)
    .where(
      and(eq(tasks.githubIssue, issueRef), eq(tasks.kind, "triage"), eq(tasks.status, "completed"))
    )
    .orderBy(desc(tasks.createdAt))
    .limit(1)
    .get();
  return normalizeModelTier(row?.tier ?? null);
}
