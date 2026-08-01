/**
 * The impure side of the fleet read model: assemble FleetRows from the
 * database and boot-time capacity, then hand them to the pure buildFleetView.
 * Everything here is a thin query layer — no fleet logic lives in this file.
 */

import { db } from "@/db";
import { messages, projects, runs, tasks } from "@/db/schema";
import { and, eq, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { getConfig } from "../config";
import { getCapacity } from "../orchestrator/capacity";
import {
  buildFleetView,
  type FleetRows,
  type FleetView,
} from "./fleet-view";

/** Estate-wide daily autonomous spend cap (Phase 5 spec §Budgets). Moves to
 * config when the budgets ticket lands; the read model only needs a number. */
export const DAILY_AUTONOMOUS_CAP_USD = 500;

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export async function loadFleetRows(now: Date): Promise<FleetRows> {
  const windowStart = new Date(now.getTime() - RECENT_WINDOW_MS);

  // Slots come from the boot-time derivation; if the Docker daemon is
  // unreachable the dashboard should still render, so fall back to the
  // explicit override or a single slot rather than erroring the stream.
  let slots: number;
  try {
    slots = (await getCapacity()).slots;
  } catch {
    slots = getConfig().capacitySlots ?? 1;
  }

  const projectRows = db.select().from(projects).all();

  const runRows = db
    .select()
    .from(runs)
    .where(or(isNull(runs.finishedAt), gte(runs.finishedAt, windowStart)))
    .all();

  const taskRows = db
    .select()
    .from(tasks)
    .where(
      or(
        isNotNull(tasks.containerStatus),
        isNotNull(tasks.runId),
        gte(tasks.updatedAt, windowStart)
      )
    )
    .all();

  // Turns = the initial prompt plus one per delivered follow-up, counted for
  // every started task — not just live containers, so a blocked run whose
  // container died across a restart still shows its real turn count.
  const startedIds = taskRows
    .filter((t) => t.status !== "queued")
    .map((t) => t.id);
  const deliveredCounts = new Map<string, number>();
  if (startedIds.length > 0) {
    const counted = db
      .select({
        taskId: messages.taskId,
        delivered: sql<number>`count(*)`,
      })
      .from(messages)
      .where(
        and(
          inArray(messages.taskId, startedIds),
          eq(messages.role, "user"),
          isNotNull(messages.deliveredAt)
        )
      )
      .groupBy(messages.taskId)
      .all();
    for (const row of counted) deliveredCounts.set(row.taskId, row.delivered);
  }

  return {
    now,
    slots,
    dailyCapUsd: DAILY_AUTONOMOUS_CAP_USD,
    discordGuildId: getConfig().discordGuildId,
    projects: projectRows.map((p) => ({
      id: p.id,
      name: p.name,
      autonomyEnabled: p.autonomyEnabled,
      preflightStatus: p.preflightStatus,
      preflightReason: p.preflightReason,
      discordChannelId: p.discordChannelId,
    })),
    runs: runRows,
    tasks: taskRows.map((t) => ({
      id: t.id,
      projectId: t.projectId,
      runId: t.runId,
      kind: t.kind,
      title: t.title,
      status: t.status,
      containerStatus: t.containerStatus,
      totalCostUsd: t.totalCostUsd,
      turns:
        t.status === "queued" ? 0 : 1 + (deliveredCounts.get(t.id) ?? 0),
      githubIssue: t.githubIssue,
      pullRequestNumber: t.pullRequestNumber,
      pullRequestUrl: t.pullRequestUrl,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })),
    // Queue depth needs the tracker; the pickup/reconciliation ticket will
    // feed it. Null renders as "queue unknown" rather than a wrong zero.
    readyForAgentCount: null,
  };
}

export async function currentFleetView(now: Date): Promise<FleetView> {
  return buildFleetView(await loadFleetRows(now));
}
